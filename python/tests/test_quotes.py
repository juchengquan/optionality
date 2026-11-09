"""What a golden case cannot state about `verify_contracts`: the catch.

Mirrors the raising half of `verifyContracts` in `typescript/src/quotes.test.ts`. Both verdicts are
`quote`'s and cased, the raised one included (`unverifiable_verdict`), but a case calls a verdict and
never this catch, so nothing held whether `verify_contracts` USED it. It did not: #222 ported the
verdict and left this function on its own "OpenD unreachable", the sentence ADR 0018 replaced, which
reports an outage for a Provider that answered and declined. The TypeScript and the backend's awaited
`ports.verify_contracts` had both moved on.
"""

import re

from optionality.quotes import verify_contracts

CODE = "US.SPXW261218C6500000"


def test_refuses_when_the_probe_threw_rather_than_accepting_blind():
    def down(codes):
        raise RuntimeError("Client connection failed!")

    assert verify_contracts([CODE], down) == (
        "cannot verify contract: the Provider did not confirm it — Client connection failed!"
    )


def test_does_not_call_a_provider_that_answered_and_declined_an_outage():
    # moomoo refuses every US stock index as a CLASS, naming no culprit — so the containment loop
    # re-raises and this is the path `US..SPX` takes. The gateway is up; saying "unreachable" sends
    # the owner to look at the wrong thing, and the Provider's own sentence is what says which of the
    # two it was (ADR 0018).
    def declined(codes):
        raise RuntimeError("snapshot API failed: US stock indices are not supported")

    why = verify_contracts(["US..SPX"], declined)
    assert why is not None
    assert "US stock indices are not supported" in why
    assert not re.search(r"unreachable|down|outage", why)
