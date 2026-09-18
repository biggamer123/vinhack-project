#!/bin/sh
# Blast Radius - local backup snapshot.
#
# Records the whole working tree - tracked files, staged changes, and new files
# that are not gitignored - as a commit on refs/heads/blastradiusbackups.
#
# It never touches HEAD, the real index, or any file in the working tree. The
# snapshot is built in a throwaway index file and written with plumbing
# commands (write-tree, commit-tree, update-ref), so running it in the middle of
# someone's work changes nothing they can see except the backup branch.
#
#   sh backup.sh [trigger] [note]
#
#   trigger: interval | commit | manual | pre-restore
#
# Exit status is 0 when a backup was written or nothing had changed since the
# last one. For the pre-restore trigger it is non-zero whenever a snapshot could
# not be guaranteed, so `backup.sh pre-restore && git restore ...` never
# restores without a way back.

TRIGGER="${1:-manual}"
NOTE="${2:-}"
REF="refs/heads/blastradiusbackups"

fail() {
  if [ "$TRIGGER" = "pre-restore" ]; then
    echo "blast radius: could not take a safety backup ($1) - restore aborted, nothing was changed." >&2
    exit 1
  fi
  exit 0
}

GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || fail "not a git repository"
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || fail "no working tree"
cd "$TOP" || fail "cannot enter $TOP"

STATE="$GIT_DIR/blastradius"
mkdir -p "$STATE" || fail "cannot create $STATE"
LOCK="$STATE/backup.lock"

# One backup at a time. A lock older than 10 minutes belongs to a run that died.
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
  rmdir "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  # Another backup is running. Periodic ones can simply skip; a pre-restore
  # snapshot must wait, because the restore that follows depends on it.
  if [ "$TRIGGER" != "pre-restore" ]; then
    exit 0
  fi
  tries=0
  until mkdir "$LOCK" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -ge 30 ] && fail "another backup is still running"
    sleep 1
  done
fi

TMP_INDEX="$STATE/index.$$"
cleanup() {
  rm -f "$TMP_INDEX" "$TMP_INDEX.lock"
  rmdir "$LOCK" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Start from a copy of the real index: it carries file stat data, so git only
# re-reads files that actually changed instead of hashing the whole tree.
if [ -f "$GIT_DIR/index" ]; then
  cp "$GIT_DIR/index" "$TMP_INDEX" || fail "cannot copy the index"
fi

TREE=$(GIT_INDEX_FILE="$TMP_INDEX" sh -c 'git add -A >/dev/null 2>&1 && git write-tree') || fail "cannot snapshot the working tree"
[ -n "$TREE" ] || fail "empty snapshot"

HEAD_SHA=$(git rev-parse -q --verify HEAD 2>/dev/null)

PARENT=$(git rev-parse -q --verify "$REF^{commit}" 2>/dev/null)
if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  # Same files as the last backup. Skip only if HEAD has not moved either: a
  # commit, checkout or reset is still worth its own restore point, even when it
  # reuses the same snapshot (the tree is shared, so it costs almost nothing).
  LAST_HEAD=$(git log -1 --format=%B "$PARENT" | sed -n 's/^Backup-Head: //p')
  if [ "$LAST_HEAD" = "$HEAD_SHA" ]; then
    if [ "$TRIGGER" = "pre-restore" ]; then
      echo "blast radius: current state already saved as backup ${PARENT%"${PARENT#????????????}"} - restore it the same way if you change your mind."
    fi
    exit 0
  fi
fi
BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null || echo "(detached)")
SUBJECT=""
UNCOMMITTED=0
if [ -n "$HEAD_SHA" ]; then
  SUBJECT=$(git log -1 --format=%s "$HEAD_SHA" 2>/dev/null)
  UNCOMMITTED=$(git diff-tree -r --name-only "$HEAD_SHA^{tree}" "$TREE" 2>/dev/null | wc -l | tr -d ' ')
fi

# Author the snapshot as whoever is working here; fall back if git has no identity.
if [ -z "$(git config user.name)" ]; then
  GIT_AUTHOR_NAME="Blast Radius Backup"
  GIT_COMMITTER_NAME="Blast Radius Backup"
  export GIT_AUTHOR_NAME GIT_COMMITTER_NAME
fi
if [ -z "$(git config user.email)" ]; then
  GIT_AUTHOR_EMAIL="backup@blastradius.local"
  GIT_COMMITTER_EMAIL="backup@blastradius.local"
  export GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL
fi

MSG_FILE="$STATE/message.$$"
{
  printf 'blastradius backup: %s\n\n' "$TRIGGER"
  printf 'Backup-Trigger: %s\n' "$TRIGGER"
  printf 'Backup-Head: %s\n' "$HEAD_SHA"
  printf 'Backup-Branch: %s\n' "$BRANCH"
  printf 'Backup-Head-Subject: %s\n' "$SUBJECT"
  printf 'Backup-Uncommitted-Files: %s\n' "$UNCOMMITTED"
  printf 'Backup-Note: %s\n' "$NOTE"
} > "$MSG_FILE" || fail "cannot write the backup message"

if [ -n "$PARENT" ]; then
  COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -F "$MSG_FILE")
else
  COMMIT=$(git commit-tree "$TREE" -F "$MSG_FILE")
fi
rm -f "$MSG_FILE"
[ -n "$COMMIT" ] || fail "cannot create the backup commit"

if [ -n "$PARENT" ]; then
  git update-ref -m "blastradius backup ($TRIGGER)" "$REF" "$COMMIT" "$PARENT" || fail "cannot move the backup branch"
else
  git update-ref -m "blastradius backup ($TRIGGER)" "$REF" "$COMMIT" || fail "cannot create the backup branch"
fi

if [ "$TRIGGER" = "pre-restore" ]; then
  echo "blast radius: safety backup ${COMMIT%"${COMMIT#????????????}"} taken - restore it the same way if you change your mind."
fi
exit 0
