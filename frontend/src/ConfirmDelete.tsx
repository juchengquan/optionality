import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** Deleting a monitor was a single unguarded click, in a service whose stated rule is that
 *  nothing is ever removed without intent — quarantined contracts are disabled and kept,
 *  expired ones are muted and counted down. A misclick on a row was the one exception, and
 *  it is not reversible: the rule, its threshold and its recorded entry all go.
 *
 *  Muting stays unguarded. It undoes with one click, so asking would be noise. */
export function ConfirmDelete({
  name, what, onConfirm, children,
}: {
  name: string;
  what: string;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button type="button" variant="ghost" size="sm">{children ?? "delete"}</Button>}
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the {what} for good, along with its threshold and any entry recorded
            against it. Muting keeps the row and can be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
