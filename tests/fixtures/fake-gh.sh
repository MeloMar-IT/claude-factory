#!/bin/sh
# Stand-in for the GitHub CLI. Logs every call to $FAKE_GH_LOG; "repo clone" clones $FAKE_GH_REMOTE.
echo "gh $*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "repo view")   echo "repo: owner/repo"; echo "default branch: main" ;;
  "issue view")  printf '# #%s: Add a feature\nhttps://github.com/owner/repo/issues/%s\n\nPlease add feature.txt\n' "$3" "$3" ;;
  "issue comment") echo "--- comment on #$3:" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG"; echo "https://github.com/owner/repo/issues/$3#issuecomment-1" ;;
  "repo clone")  git clone -q "$FAKE_GH_REMOTE" "$4" ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac
