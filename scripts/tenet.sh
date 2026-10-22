#!/usr/bin/env bash
# Heavy steps run on tenet (Justin's Arch desktop: 16 threads, 15 GB), not this 8 GB Mac.
# Editing and git stay here; this ships the working tree there and runs one command in it.
#
#   scripts/tenet.sh bun run check                         # this checkout as it is now, uncommitted files too
#   scripts/tenet.sh 'cd clients/desktop/src-tauri && cargo test'
#   scripts/tenet.sh bun run build:all && scripts/tenet.sh pull dist
#   scripts/tenet.sh pull <path>…                          # copy results back into this checkout
#
# Each run snapshots the working tree as a commit (your index, stash and branches are untouched),
# pushes it to tenet's ~/work/midna — ~/work/midna-<name> for a git worktree here — checks it out
# there, runs `bun install` when a manifest or yagami changed, and runs the command with this Mac's
# bun version, in background.slice under a memory cap (TENET_MEM, default 6G) so Justin's desktop
# stays responsive. One argument is a shell line; several are quoted as words. The exit status is
# the command's. It pushes only to tenet, never to origin.
set -euo pipefail

# The half that runs on tenet, fetched from the snapshot itself: remote <slot> <sha> <yagami sha> <mem> <bun> <command>.
remote() {
  local slot=$1 sha=$2 ysha=$3 mem=$4 bunv=$5 cmd=$6
  local repo=$HOME/work/midna dir=$HOME/work/$slot
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  # Low priority, capped, and outside any unit's identity: with INVOCATION_ID set the daemon's
  # tests would start real systemd-run jobs. systemd-run would expand $VAR in the command itself.
  run() {
    systemd-run --user --scope --quiet --expand-environment=no --slice=background -p "MemoryMax=$mem" -p CPUWeight=20 \
      -- env -u INVOCATION_ID nice -n 10 mise exec "bun@$bunv" -- "$@"
  }

  exec 9>"$repo/.git/tenet-$slot.lock"
  flock -n 9 || { echo "tenet: waiting for the run already going in ~/work/$slot" >&2; flock 9; }
  [ -e "$dir" ] || git -C "$repo" worktree add -q --detach "$dir" "$sha"
  cd "$dir"
  git checkout -q --detach -f "$sha"
  git clean -q -fd
  git -C "$repo" for-each-ref --format='%(refname)' refs/tenet/ | while read -r ref; do
    [ "$ref" = "refs/tenet/$sha" ] || git -C "$repo" update-ref -d "$ref"
  done

  # packages/agent depends on file:../../../yagami: a sibling checkout, built.
  if [ -n "$ysha" ]; then
    (
      cd "$HOME/work/yagami"
      exec 8>.git/tenet.lock && flock 8
      if [ "$(git rev-parse HEAD)" != "$ysha" ] || [ ! -f dist/index.js ]; then
        echo "tenet: building yagami at ${ysha:0:7}" >&2
        git checkout -q --detach -f "$ysha"
        run bash -c 'bun install --frozen-lockfile >/dev/null && bun run build >/dev/null'
      fi
      git for-each-ref --format='%(refname)' refs/tenet/ | while read -r ref; do
        [ "$ref" = "refs/tenet/$ysha" ] || git update-ref -d "$ref"
      done
    )
  fi
  local stamp
  stamp="$ysha $(git ls-tree -r HEAD | grep -E '(^|/)(package\.json|bun\.lock)$' | sha1sum)"
  if [ "$(cat node_modules/.tenet-stamp 2>/dev/null)" != "$stamp" ]; then
    echo "tenet: bun install" >&2
    rm -rf node_modules/.bun/@justin06lee+yagami@*
    run bun install --frozen-lockfile >/dev/null
    echo "$stamp" >node_modules/.tenet-stamp
  fi

  echo "tenet: ~/work/$slot at ${sha:0:7}" >&2
  run bash -c "$cmd"
}
if [ "${1:-}" = --remote ]; then shift; remote "$@"; exit; fi

host=${TENET_HOST:-tenet}
ssh_opts=(-o BatchMode=yes -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=60)
export GIT_SSH_COMMAND="ssh ${ssh_opts[*]}"
top=$(git rev-parse --show-toplevel)
cd "$top"
main=$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")
if [ "$top" = "$main" ]; then slot=midna; else slot="midna-$(basename "$top")"; fi

if [ $# -eq 0 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

if [ "$1" = pull ]; then
  shift
  [ $# -gt 0 ] || { echo "usage: scripts/tenet.sh pull <path>…" >&2; exit 2; }
  for p in "$@"; do
    p=${p%/}
    mkdir -p "$(dirname "$p")"
    rsync -a -e "ssh ${ssh_opts[*]}" "$host:work/$slot/$p" "$(dirname "$p")/"
  done
  exit 0
fi

# The working tree as a commit, through a scratch index: tracked changes and untracked files, not ignored ones.
idx=$(mktemp "${TMPDIR:-/tmp}/tenet-index.XXXXXX")
trap 'rm -f "$idx"' EXIT
cp "$(git rev-parse --git-path index)" "$idx"
GIT_INDEX_FILE=$idx git add -A
tree=$(GIT_INDEX_FILE=$idx git write-tree)
if [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ]; then
  sha=$(git rev-parse HEAD)
else
  sha=$(git commit-tree "$tree" -p HEAD -m "tenet snapshot of $slot")
fi
# A ref per snapshot, so no push ever rewrites one; tenet drops the old ones.
git push -q "$host:work/midna" "$sha:refs/tenet/$sha"
ysha=
if [ -d "$main/../yagami/.git" ]; then
  ysha=$(git -C "$main/../yagami" rev-parse HEAD)
  git -C "$main/../yagami" push -q "$host:work/yagami" "$ysha:refs/tenet/$ysha"
fi

if [ $# -eq 1 ]; then cmd=$1; else cmd=$(printf '%q ' "$@"); fi
args=$(printf '%q ' "$slot" "$sha" "$ysha" "${TENET_MEM:-6G}" "${TENET_BUN:-$(bun --version)}" "$cmd")
tty=-T
if [ -t 0 ] && [ -t 1 ]; then tty=-t; fi
exec ssh "${ssh_opts[@]}" "$tty" "$host" "bash -c \"\$(git -C ~/work/midna show $sha:scripts/tenet.sh)\" tenet.sh --remote $args"
