import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import { cn } from "cn"

/** Not from the shadcn registry — it has no number field. This is Base UI's, wearing the
 *  same classes as the Input next to it so the two are indistinguishable on screen.
 *
 *  The reason for using it at all: <input type="number"> changes its value when the wheel
 *  scrolls over a focused box. On a page you scroll through while reading, that turns a
 *  gesture into an edit, and the edit is a threshold an alarm fires on. */
function NumberField({
  className,
  value,
  onValueChange,
  placeholder,
  ...props
}: NumberFieldPrimitive.Root.Props & { className?: string; placeholder?: string }) {
  return (
    <NumberFieldPrimitive.Root value={value} onValueChange={onValueChange} {...props}>
      <NumberFieldPrimitive.Input
        data-slot="number-field"
        placeholder={placeholder}
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50",
          className
        )}
      />
    </NumberFieldPrimitive.Root>
  )
}

export { NumberField }
