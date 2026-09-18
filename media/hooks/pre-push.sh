#!/bin/sh
# Blast Radius - push guard.
#
# Keeps refs/heads/blastradiusbackups on this machine. Called by the pre-push
# hook with the remote name and URL as arguments and one line per ref on stdin:
#
#   <local ref> <local sha> <remote ref> <remote sha>
#
# A pre-push hook cannot edit a push, only allow or refuse it. So when the
# backup branch is part of a push (git push --all, --mirror, or naming it), this
# refuses the original push, pushes every OTHER ref itself, and says so. An
# ordinary `git push` of the current branch never includes the backup branch and
# passes straight through.

BACKUP_REF="refs/heads/blastradiusbackups"

# The push we start below re-enters this hook; let it through.
if [ -n "$BLASTRADIUS_PUSH_GUARD" ]; then
  exit 0
fi

REMOTE="$1"
GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
STATE="$GIT_DIR/blastradius"
mkdir -p "$STATE"
IN="$STATE/push.$$"
KEEP="$STATE/push.$$.keep"
trap 'rm -f "$IN" "$KEEP"' EXIT
cat > "$IN"

# Run any pre-push hook that was here before us, with the same input. If it
# refuses the push, that decision stands.
if [ -n "$BLASTRADIUS_HOOKS_DIR" ] && [ -x "$BLASTRADIUS_HOOKS_DIR/pre-push.blastradius-chained" ]; then
  "$BLASTRADIUS_HOOKS_DIR/pre-push.blastradius-chained" "$@" < "$IN" || exit $?
fi

# Common case: the backup branch is not involved at all.
if ! awk -v ref="$BACKUP_REF" '$1 == ref || $3 == ref { found = 1 } END { exit found ? 0 : 1 }' "$IN"; then
  exit 0
fi

awk -v ref="$BACKUP_REF" '$1 != ref && $3 != ref' "$IN" > "$KEEP"

log_event() {
  printf '{"t":%s000,"kind":"push-guard","remote":"%s","others":%s,"status":%s}\n' \
    "$(date +%s)" "$(printf '%s' "$REMOTE" | tr -d '"\\')" "$1" "$2" >> "$STATE/events.jsonl" 2>/dev/null
}

echo "" >&2
echo "  blast radius: $BACKUP_REF is local-only and was removed from this push." >&2

if [ ! -s "$KEEP" ]; then
  echo "  blast radius: nothing else was being pushed, so nothing was sent." >&2
  echo "" >&2
  log_event 0 0
  exit 1
fi

# Rebuild the push from the remaining lines. A line arriving here that is not a
# fast-forward means the original push was forced (git refuses those before this
# hook otherwise), so only those refs get a forcing "+".
is_zero() {
  case "$1" in
    *[!0]*) return 1 ;;
    *) return 0 ;;
  esac
}

SPECS=""
while read -r LREF LSHA RREF RSHA; do
  [ -n "$RREF" ] || continue
  if is_zero "$LSHA"; then
    SPECS="$SPECS :$RREF"
    continue
  fi
  FORCE=""
  if ! is_zero "$RSHA"; then
    if ! git cat-file -e "$RSHA^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$RSHA" "$LSHA" 2>/dev/null; then
      FORCE="+"
    fi
  fi
  SPECS="$SPECS $FORCE$LSHA:$RREF"
done < "$KEEP"

echo "  blast radius: pushing everything else to $REMOTE:" >&2
# shellcheck disable=SC2086
BLASTRADIUS_PUSH_GUARD=1 git push --no-verify "$REMOTE" $SPECS >&2
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "  blast radius: done. Git will now report the original push as failed - that refers only to the withheld backup branch." >&2
else
  echo "  blast radius: pushing the other refs failed (exit $STATUS) - see the output above." >&2
fi
echo "" >&2
log_event 1 "$STATUS"
exit 1
