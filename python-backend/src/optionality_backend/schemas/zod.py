"""zod's refusals, in zod's words, for the request schemas beside this module. Python-only: the
TypeScript has them from the `zod` library, which has no Python.

A request the API refuses answers 422 with `z.prettifyError`'s text as its `detail`, and the dashboard
prints that verbatim (`entrypoints/http/validate.ts`) — so the words are behaviour, held by the door
scenarios ("✖ Too small: expected array to have >=1 items\\n  → at legs"). pydantic refuses the same
values in other words, and in places refuses different values: its strict `Literal[1, -1]` takes
`true`, its strict `int` refuses `2.0`, which JavaScript cannot tell from `2`, and it reports an
array's elements without its length or its length without its elements, where zod reports both.

So the schemas stay pydantic models, as every zod schema becomes one (README, "Names"), and each
field carries the zod schema it is — `Annotated[float, Number()]` for `z.number()` — which does zod's
checks itself, in zod's order, and raises zod's issues in zod's words before pydantic's own strict
check sees the value. pydantic only gathers them, field by field in declaration order, which is the
order zod walks a shape. `Shape` is `z.object`, and refuses at class creation a field that carries no
check here, because that field would be refused in pydantic's words. `parse` is `schema.parse`,
`ZodError` its error, and `prettify_error` is `z.prettifyError`.

Only what the schemas use, measured against zod 4.6 itself: every one of 3,215 bodies — each field of
each schema given each of fifty-seven JSON values, absent, and wrong two at a time, and every schema
given a body that is not an object — answers here as it does there, refusal for refusal and word for
word. Including what zod does by being zod: an absent key is checked as `undefined` (so a missing enum
is "Invalid option", not "received undefined"); a length check runs on whatever has a length even
after the type has been refused (`"legs": "x"` is two issues); `z.int()` refuses an integer outside
the safe range; and a JSON number is a JavaScript number, so `2.0` is an int and `1e400` is Infinity.
"""

import json
import math
import re
import types
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Literal, Self, TypeAliasType, Union, get_args, get_origin

from optionality.js import js_string, number
from pydantic import BaseModel, ConfigDict, GetCoreSchemaHandler, ValidationError, model_validator
from pydantic_core import CoreSchema, PydanticCustomError, core_schema

#: where an issue is, from the body down: a key, or an index into an array
type Path = tuple[str | int, ...]
#: one of zod's issues, as `prettifyError` reads it: where, and the message
type Issue = tuple[Path, str]

#: JavaScript's whitespace, which `String.prototype.trim` strips: its WhiteSpace and LineTerminator.
#: `str.strip()` with no argument also strips \x1c-\x1f, which JavaScript keeps.
JS_WHITESPACE = "\t\n\v\f\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

MAX_SAFE_INTEGER = 2**53 - 1


class _Undefined:
    """JavaScript's `undefined`: a key the body did not carry, which zod checks like any value."""

    def __repr__(self) -> str:
        return "undefined"


UNDEFINED = _Undefined()


class CustomIssue(Exception):
    """What a transform raises to refuse its value: `ctx.addIssue({ code: "custom", message })`."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ZodError(Exception):
    """A refused value, and every issue zod found in it."""

    def __init__(self, issues: list[Issue]) -> None:
        super().__init__(prettify_issues(issues))
        self.issues = issues


def _double(value: float) -> float:
    """The JavaScript number a JSON number is: Python keeps an integer exact and unbounded."""
    try:
        return float(value)
    except OverflowError:
        # past the largest double, which JSON.parse reads as an infinity of the same sign
        return math.inf if value > 0 else -math.inf


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _received(value: Any) -> str:
    """zod's name for what it was given (`util.parsedType`, then the locale's `getTypeName`)."""
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if _is_number(value):
        x = _double(value)
        # a number that is not finite is named by its value, which is how JSON's 1e400 reads
        return "NaN" if math.isnan(x) else js_string(x) if math.isinf(x) else "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _invalid_type(expected: str, value: Any) -> str:
    return f"Invalid input: expected {expected}, received {_received(value)}"


def _primitive(value: Any) -> str:
    """`util.stringifyPrimitive`: a string in double quotes, unescaped, and a number as JavaScript
    writes it."""
    if isinstance(value, str):
        return f'"{value}"'
    if isinstance(value, bool):
        return "true" if value else "false"
    return js_string(_double(value))


def _min_length(value: Any, minimum: int | None) -> list[str]:
    """`.min(n)` on a string or an array: `$ZodCheckMinLength`.

    It guards itself — it runs on anything with a `length` that is not null — so zod runs it even when
    the value's TYPE was refused, on the value it refused: `"legs": "x"` is "expected array" and then
    "expected string to have >=2 characters". An object counts when it has a "length" key, compared as
    JavaScript compares anything with a number. A string's length is in code points, as zod 4.6 counts
    a string near its floor, and as Python counts every string."""
    if minimum is None or value is None or value is UNDEFINED:
        return []
    if isinstance(value, (str, list)):
        enough = len(value) >= minimum
        origin = "string" if isinstance(value, str) else "array"
    elif isinstance(value, dict) and "length" in value:
        enough = number(value["length"]) >= minimum
        origin = "unknown"
    else:
        return []
    if enough:
        return []
    unit = {"string": "characters", "array": "items"}.get(origin)
    return [
        f"Too small: expected {origin} to have >={minimum} {unit}"
        if unit
        else f"Too small: expected {origin} to be >={minimum}"
    ]


def _max_length(value: Any, maximum: int | None) -> list[str]:
    """`.max(n)` on an array: `$ZodCheckMaxLength`, `_min_length`'s mirror, guarded the same way — so
    it too runs on a value whose TYPE was refused (`"xyz"` is "expected array" and then "expected
    string to have <=2 characters"), and on an object with a "length" key."""
    if maximum is None or value is None or value is UNDEFINED:
        return []
    if isinstance(value, (str, list)):
        small = len(value) <= maximum
        origin = "string" if isinstance(value, str) else "array"
    elif isinstance(value, dict) and "length" in value:
        small = number(value["length"]) <= maximum
        origin = "unknown"
    else:
        return []
    if small:
        return []
    unit = {"string": "characters", "array": "items"}.get(origin)
    return [
        f"Too big: expected {origin} to have <={maximum} {unit}"
        if unit
        else f"Too big: expected {origin} to be <={maximum}"
    ]


def _refuse(issues: list[Issue]) -> PydanticCustomError:
    """A field's issues, handed to pydantic to gather. Their paths are relative to the field; pydantic
    prefixes where the field is."""
    return PydanticCustomError("zod", "{message}", {"message": issues[0][1], "issues": issues})


def issues_of(err: ValidationError) -> list[Issue]:
    """The issues a validation found, in the order zod would have found them."""
    found: list[Issue] = []
    for e in err.errors(include_url=False, include_input=False):
        if e["type"] == "zod":
            found += [((*e["loc"], *path), message) for path, message in e["ctx"]["issues"]]
        else:
            # pydantic's own refusal of what a check here passed it, which `Shape`'s guard and the
            # suite make a bug: zod's word for an issue it has no message for, rather than pydantic's
            found.append((tuple(e["loc"]), "Invalid input"))
    return found


@dataclass(frozen=True, kw_only=True)
class Check:
    """One field's zod schema, which pydantic runs before its own strict check of the field's type.

    A field that may be ABSENT is `.optional()`: it defaults to None, and an explicit null is checked
    like any value and refused, as zod refuses one. `.nullish()` lets null through as well."""

    nullable: bool = False

    def nullish(self) -> Self:
        return replace(self, nullable=True)

    def check(self, value: Any) -> tuple[Any, list[str]]:
        """The value as the field should hold it, and zod's messages about it (empty when it passes)."""
        raise NotImplementedError

    def bind(self, source: Any) -> Self:
        """This check for the field's declared type, which a check may read from (`Enum`)."""
        return self

    def parse(self, value: Any, handler: core_schema.ValidatorFunctionWrapHandler) -> Any:
        out, messages = self.check(value)
        if messages:
            raise _refuse([((), m) for m in messages])
        return handler(out)

    def __get_pydantic_core_schema__(self, source: Any, handler: GetCoreSchemaHandler) -> CoreSchema:
        bound = self.bind(source)

        def run(value: Any, inner: core_schema.ValidatorFunctionWrapHandler) -> Any:
            if bound.nullable and value is None:
                return inner(value)
            return bound.parse(value, inner)

        return core_schema.no_info_wrap_validator_function(run, handler(source))


@dataclass(frozen=True, kw_only=True)
class String(Check):
    """`z.string()`, then `.trim()`, then `.min(n)`, then `.transform(f)`, in that order.

    A transform refuses with `CustomIssue`, and runs only on a string that passed the rest: zod pipes
    into it, and a pipe stops at the first side's issues."""

    trim: bool = False
    min: int | None = None
    transform: Callable[[str], str] | None = None

    def check(self, value: Any) -> tuple[Any, list[str]]:
        if not isinstance(value, str):
            return value, [_invalid_type("string", value), *_min_length(value, self.min)]
        if self.trim:
            value = value.strip(JS_WHITESPACE)
        short = _min_length(value, self.min)
        if short or self.transform is None:
            return value, short
        try:
            return self.transform(value), []
        except CustomIssue as issue:
            return value, [issue.message]


@dataclass(frozen=True, kw_only=True)
class Number(Check):
    """`z.number()`: any finite number, and nothing else — not a boolean, not a numeric string. With
    `positive`, `.positive()` as well: above zero, checked only on a number."""

    positive: bool = False

    def check(self, value: Any) -> tuple[Any, list[str]]:
        if not (_is_number(value) and math.isfinite(_double(value))):
            return value, [_invalid_type("number", value)]
        if self.positive and not _double(value) > 0:
            return value, ["Too small: expected number to be >0"]
        return value, []


@dataclass(frozen=True, kw_only=True)
class Int(Check):
    """`z.int()`, then `.min(n)` and `.max(n)`. A number first — so a string is "expected number" — then
    an integer, which `2.0` is; then a SAFE one, which does not stop `.min(n)` from also being checked."""

    min: int | None = None
    max: int | None = None

    def check(self, value: Any) -> tuple[Any, list[str]]:
        if not (_is_number(value) and math.isfinite(_double(value))):
            return value, [_invalid_type("number", value)]
        x = _double(value)
        if not x.is_integer():
            return value, [_invalid_type("int", value)]
        found = []
        if x > MAX_SAFE_INTEGER:
            found.append(f"Too big: expected int to be <={MAX_SAFE_INTEGER}")
        elif x < -MAX_SAFE_INTEGER:
            found.append(f"Too small: expected int to be >={-MAX_SAFE_INTEGER}")
        if self.min is not None and x < self.min:
            found.append(f"Too small: expected number to be >={self.min}")
        if self.max is not None and x > self.max:
            found.append(f"Too big: expected number to be <={self.max}")
        return int(value), found


@dataclass(frozen=True, kw_only=True)
class Never(Check):
    """`z.never({ error })`: any value at all is refused, with `error` — so `.optional()` lets the key be
    absent and nothing else, null included."""

    error: str

    def check(self, value: Any) -> tuple[Any, list[str]]:
        return value, [self.error]


@dataclass(frozen=True, kw_only=True)
class Boolean(Check):
    """`z.boolean()`: true or false, and not 0 or 1."""

    def check(self, value: Any) -> tuple[Any, list[str]]:
        return value, [] if isinstance(value, bool) else [_invalid_type("boolean", value)]


def _literal_values(source: Any) -> tuple[Any, ...]:
    """The values of the `Literal` a field is declared as, through aliases and `| None`."""
    if isinstance(source, TypeAliasType):
        return _literal_values(source.__value__)
    if get_origin(source) is Literal:
        return get_args(source)
    if get_origin(source) in (Union, types.UnionType):
        return tuple(v for arg in get_args(source) if arg is not type(None) for v in _literal_values(arg))
    raise TypeError(f"Enum() needs a field declared as a Literal, not {source!r}")


@dataclass(frozen=True, kw_only=True)
class Enum(Check):
    """`z.enum([...])` and `z.literal([...])`: one of the values the field's `Literal` declares, as
    JavaScript's Set compares them — `1.0` is `1`, and `true` is not. Absent is "Invalid option" like any
    other wrong value, because zod checks the enum before anything else."""

    values: tuple[Any, ...] = ()

    def bind(self, source: Any) -> Self:
        return self if self.values else replace(self, values=_literal_values(source))

    def check(self, value: Any) -> tuple[Any, list[str]]:
        for v in self.values:
            if isinstance(value, str) and isinstance(v, str) and value == v:
                return v, []
            if _is_number(value) and _is_number(v) and _double(value) == v:
                return v, []
        if len(self.values) == 1:
            return value, [f"Invalid input: expected {_primitive(self.values[0])}"]
        return value, [f"Invalid option: expected one of {'|'.join(_primitive(v) for v in self.values)}"]


@dataclass(frozen=True, kw_only=True)
class Array(Check):
    """`z.array(item).min(n).max(m)`. Every element's issues AND the length's, which pydantic will not
    give together: it reports the elements of a list that is also too short, and stops there."""

    min: int | None = None
    max: int | None = None

    def _lengths(self, value: Any) -> list[str]:
        return [*_min_length(value, self.min), *_max_length(value, self.max)]

    def parse(self, value: Any, handler: core_schema.ValidatorFunctionWrapHandler) -> Any:
        if not isinstance(value, list):
            raise _refuse([((), m) for m in [_invalid_type("array", value), *self._lengths(value)]])
        issues: list[Issue] = []
        out = None
        try:
            out = handler(value)
        except ValidationError as err:
            issues += issues_of(err)
        issues += [((), m) for m in self._lengths(value)]
        if issues:
            raise _refuse(issues)
        return out


class Shape(BaseModel):
    """`z.object({...})`: an object, whose keys are checked in the order they are declared, with every
    key it does not declare dropped.

    Strict, and refusing a number that is not finite, as the tracer's answers are: by the time
    pydantic's own check sees a value a `Check` has passed it, it must agree — and if it ever does not,
    the refusal reads "Invalid input" rather than in pydantic's words. Frozen, because what a route
    was given is not something it should be able to change."""

    model_config = ConfigDict(strict=True, allow_inf_nan=False, frozen=True)

    @classmethod
    def __pydantic_init_subclass__(cls, **kwargs: Any) -> None:
        super().__pydantic_init_subclass__(**kwargs)
        for name, info in cls.model_fields.items():
            if not any(isinstance(m, Check) for m in info.metadata):
                raise TypeError(
                    f"{cls.__name__}.{name} has no zod schema (schemas/zod.py): pydantic would refuse it in "
                    "its own words, and the dashboard prints zod's"
                )

    @model_validator(mode="before")
    @classmethod
    def _object(cls, value: Any) -> Any:
        if isinstance(value, cls):
            return value
        if not isinstance(value, dict):
            raise _refuse([((), _invalid_type("object", value))])
        # zod checks a key the body did not carry as `undefined`, and says so; pydantic would say
        # "Field required" without asking the field. An optional key is left absent, to its default.
        absent = {n: UNDEFINED for n, f in cls.model_fields.items() if f.is_required() and n not in value}
        return {**value, **absent}


def _members(schema: Any) -> tuple[Any, ...] | None:
    """The shapes a union alias (`type X = A | B`) names, or None for a single shape."""
    if isinstance(schema, TypeAliasType):
        schema = schema.__value__
    if get_origin(schema) in (Union, types.UnionType):
        return get_args(schema)
    return None


def parse[T: Shape](schema: type[T] | TypeAliasType, value: Any) -> T:
    """`schema.parse(value)`: the value as the schema's model, or `ZodError` with every issue.

    A union answers its first member that accepts the value, and when none does, one issue with no
    reason, "Invalid input": a union cannot know whose complaint applies (see `monitor_create_member`
    in `monitor.py`, which is how a route avoids it)."""
    members = _members(schema)
    if members is not None:
        for member in members:
            try:
                return member.model_validate(value)
            except ValidationError:
                continue
        raise ZodError([((), "Invalid input")])
    assert isinstance(schema, type)
    try:
        return schema.model_validate(value)
    except ValidationError as err:
        raise ZodError(issues_of(err)) from None


_WORD = re.compile(r"[\w$]*", re.ASCII)


def _dot_path(path: Path) -> str:
    """`toDotPath`: `legs[0].sign`, with a key that is not a JavaScript word in brackets and quotes."""
    segs: list[str] = []
    for seg in path:
        if isinstance(seg, int):
            segs.append(f"[{seg}]")
        elif not _WORD.fullmatch(seg):
            segs.append(f"[{json.dumps(seg, ensure_ascii=False)}]")
        else:
            if segs:
                segs.append(".")
            segs.append(seg)
    return "".join(segs)


def prettify_issues(issues: list[Issue]) -> str:
    """`z.prettifyError`'s text: each issue with a cross, and where it is under it, shallowest first.

    Sorted by how deep the issue is, and stably, so issues at one depth keep the order zod found them
    in — which is what makes the order of a shape's keys part of what the API says."""
    lines = []
    for path, message in sorted(issues, key=lambda issue: len(issue[0])):
        lines.append(f"✖ {message}")
        if path:
            lines.append(f"  → at {_dot_path(path)}")
    return "\n".join(lines)


def prettify_error(err: ZodError) -> str:
    """`z.prettifyError(err)`."""
    return prettify_issues(err.issues)
