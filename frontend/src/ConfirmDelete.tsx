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
  name, what, onConfirm, children, description,
}: {
  name: string;
  what: string;
  onConfirm: () => void;
  children?: React.ReactNode;
  /** What is lost, where the default is wrong for the subject. A holding has no threshold and
   *  cannot be muted, so the monitor wording below would reassure about the wrong things and
   *  stay silent about the one that matters: its recorded history. */
  description?: React.ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button type="button" variant="ghost" size="sm">{children ?? "delete"}</Button>}
      />
      {/* a reload would re-render the row this is anchored in and take the question away
          mid-decision, so it holds the poll off (App.beingOperated) */}
      <AlertDialogContent data-poll="hold">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {description ?? (
              <>
                This removes the {what} for good, along with its threshold and any entry recorded
                against it. Muting keeps the row and can be undone.
              </>
            )}
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
