#!/bin/sh
# Stand-in for the GitHub CLI. Logs every call to $FAKE_GH_LOG; "repo clone <url> <folder> -- <git flags>" clones $FAKE_GH_REMOTE into the folder.
# State lives next to the log: $FAKE_GH_LOG.pr (PR url once created), $FAKE_GH_LOG.checks (CI call count).
echo "gh $*" >> "$FAKE_GH_LOG"
# $FAKE_GH_EXPECT_TOKEN (set, also when empty): a call whose GH_TOKEN differs fails like GitHub does for a bad token.
if [ -n "${FAKE_GH_EXPECT_TOKEN+x}" ] && [ "$GH_TOKEN" != "$FAKE_GH_EXPECT_TOKEN" ]; then echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1; fi
if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; fi
# $FAKE_GH_FAIL="issue list": that call prints $FAKE_GH_FAIL_TEXT (default "boom") to stderr and fails.
if [ -n "$FAKE_GH_FAIL" ] && [ "$FAKE_GH_FAIL" = "$1 $2" ]; then printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; fi
# Edit or delete of a comment (gh api repos/…/issues/comments/<id> [-X DELETE]): logged, the edit with the body field of the JSON on stdin.
all="$*"
case "$all" in "api repos/"*"/issues/comments/"*)
  id=${all##*/issues/comments/}; id=${id%% *}
  case "$all" in
    *DELETE*) echo "--- comment delete $id" >> "$FAKE_GH_LOG" ;;
    *) echo "--- comment edit $id:" >> "$FAKE_GH_LOG"
       node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).body))' >> "$FAKE_GH_LOG" ;;
  esac
  echo '{}'; exit 0 ;;
esac
# REST calls for bug stories. State: $FAKE_GH_LOG.issues.json (issues made by the POST). $FAKE_GH_FAIL_API=list|read|create makes that call fail.
api_fail() { [ "$FAKE_GH_FAIL_API" = "$1" ] && { printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; }; }
case "$all" in
  "api repos/"*"/issues -X POST --input -")
    api_fail create
    repo=${all#api repos/}; repo=${repo%%/issues*}
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const b=JSON.parse(s);const n=Math.max(100,...l.map(x=>x.number))+1;const i={number:n,state:"open",state_reason:null,title:b.title,body:b.body,labels:(b.labels||[]).map(name=>({name})),html_url:"https://github.com/"+process.argv[2]+"/issues/"+n,created_at:new Date().toISOString(),closed_at:null};l.push(i);fs.writeFileSync(f,JSON.stringify(l));fs.appendFileSync(process.env.FAKE_GH_LOG,"--- created issue (api):\n"+s+"\n--- end issue\n");console.log(JSON.stringify(i))})' "$FAKE_GH_LOG.issues.json" "$repo"
    exit 0 ;;
  "api repos/"*"/issues?"*)
    api_fail list
    if [ -n "$FAKE_GH_BUG_ISSUES" ]; then printf '%s\n' "$FAKE_GH_BUG_ISSUES"
    elif [ -f "$FAKE_GH_LOG.issues.json" ]; then node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).reverse()))' "$FAKE_GH_LOG.issues.json"
    else echo '[]'; fi
    exit 0 ;;
  "api repos/"*"/issues/"[0-9]*)
    api_fail read
    node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const i=l.find(x=>x.number===Number(process.argv[2]));if(!i){console.error("gh: Not Found (HTTP 404)");process.exit(1)}console.log(JSON.stringify(i))' "$FAKE_GH_LOG.issues.json" "${all##*/issues/}"
    exit $? ;;
esac
case "$all" in "api rate_limit") if [ -n "$FAKE_GH_RATE_LIMIT" ]; then printf '%s\n' "$FAKE_GH_RATE_LIMIT"; else echo '{"resources":{}}'; fi; exit 0 ;; esac
case "$1 $2" in
  "repo view")
    case "$*" in *--jq*|*nameWithOwner*) echo "repo: owner/repo"; echo "default branch: main" ;;
      *defaultBranchRef*) echo '{"defaultBranchRef":{"name":"main"}}' ;;
      *) echo "repo: owner/repo" ;;
    esac ;;
  "issue view")
    case "$*" in *"-q .title"*) echo "Add a feature" ;;
      *"--json labels --jq"*) [ -n "$FAKE_GH_FAIL_LABELS" ] && { echo boom >&2; exit 1; }; printf '%s\n' ${FAKE_GH_ISSUE_LABELS:-} ;;
      *"--json state") node -e 'const n=Number(process.argv[1]);const l=JSON.parse(process.env.FAKE_GH_FRESH||process.env.FAKE_GH_ISSUES||"[]");const i=l.find(x=>x.number===n)||{state:"OPEN"};console.log(JSON.stringify({state:i.state||"OPEN"}))' "$3" ;;
      *"--json state,labels"*) node -e 'const n=Number(process.argv[1]);const l=JSON.parse(process.env.FAKE_GH_FRESH||process.env.FAKE_GH_ISSUES||"[]");const i=l.find(x=>x.number===n)||{state:"OPEN",labels:[]};console.log(JSON.stringify({state:i.state||"OPEN",labels:i.labels||[]}))' "$3" ;;
      *"--json title,body,labels,comments"*) c=${FAKE_GH_PARENT:-}; [ -n "$c" ] || c='{"title":"Add a feature","body":"**Epic:** Updates\n\nPlease add feature.txt","labels":[{"name":"enhancement"},{"name":"Factory_go"},{"name":"Factory_working"}],"comments":[]}'; printf '%s' "$c" ;;
      *"--json comments,labels"*) c=${FAKE_GH_COMMENTS:-}; [ -n "$c" ] || c='{"comments":[]}'; printf '%s' "$c" ;;
      *"--json state"*) echo "${FAKE_GH_ISSUE_STATE:-OPEN}" ;;
      *) printf '# #%s: Add a feature\nhttps://github.com/owner/repo/issues/%s\n\nPlease add feature.txt\n' "$3" "$3"
         if [ -n "$FAKE_GH_ISSUE_EXTRA" ]; then printf '%s\n' "$FAKE_GH_ISSUE_EXTRA"; fi ;;
    esac ;;
  "issue comment"|"pr comment") echo "--- comment on #$3:" >> "$FAKE_GH_LOG"
    case "$*" in *--body-file*) cat >> "$FAKE_GH_LOG" ;;
      *) prev=""; for a in "$@"; do [ "$prev" = "--body" ] && printf '%s\n' "$a" >> "$FAKE_GH_LOG"; prev="$a"; done ;;
    esac
    printf '\n--- end comment\n' >> "$FAKE_GH_LOG" # a body may end without a line end
    cn=$(($(cat "$FAKE_GH_LOG.comments" 2>/dev/null || echo 0) + 1)); echo "$cn" > "$FAKE_GH_LOG.comments"
    echo "https://github.com/owner/repo/issues/$3#issuecomment-$cn" ;;
  "issue create") n=$(($(cat "$FAKE_GH_LOG.created" 2>/dev/null || echo 100) + 1)); echo "$n" > "$FAKE_GH_LOG.created"
                  echo "--- created issue: $*" >> "$FAKE_GH_LOG"; case "$*" in *--body-file*) cat >> "$FAKE_GH_LOG" ;; esac
                  echo "https://github.com/owner/repo/issues/$n" ;;
  "issue close") ;;
  "issue list")  case "$*" in *"--state closed"*) printf '%s' "${FAKE_GH_CLOSED_ISSUES:-[]}" ;;
                   *"--search"*) printf '%s' "${FAKE_GH_PRIORITY_ISSUES:-${FAKE_GH_ISSUES:-[]}}" ;;
                   *) printf '%s' "${FAKE_GH_ISSUES:-[]}" ;; esac ;;
  "pr list")     case "$*" in *"--state merged"*) printf '%s' "${FAKE_GH_MERGED_PRS:-[]}"; exit 0 ;; esac
                 if [ -n "$FAKE_GH_PRS" ]; then printf '%s' "$FAKE_GH_PRS"; elif [ -f "$FAKE_GH_LOG.prs.json" ]; then cat "$FAKE_GH_LOG.prs.json"; else echo '[]'; fi ;;
  "issue edit") case "$*" in *--body-file*) echo "--- issue body edit: $*" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG" ;; esac ;;
  "label create") name=$3 # names are kept in $FAKE_GH_LOG.labels; without --force an existing one is an error
    case "$*" in *--force*) grep -qxF -- "$name" "$FAKE_GH_LOG.labels" 2>/dev/null || echo "$name" >> "$FAKE_GH_LOG.labels" ;;
      *) if grep -qxF -- "$name" "$FAKE_GH_LOG.labels" 2>/dev/null; then echo "label with name \"$name\" already exists; use --force to update its color and description" >&2; exit 1; fi
         echo "$name" >> "$FAKE_GH_LOG.labels" ;;
    esac ;;
  "pr edit")     echo "--- pr edit: $*" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG" ;;
  "pr ready")    ;;
  "repo clone")  # the folder is $4; the flags after "--" go to git clone, as in the real gh (the remote is a local folder, so any GIT_ALLOW_PROTOCOL is dropped)
                 dest="$4"; shift 4; [ "$1" = "--" ] && shift
                 ( unset GIT_ALLOW_PROTOCOL; git clone "$@" "$FAKE_GH_REMOTE" "$dest" ) ;;
  "pr create")   echo "--- pr body:" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG"
                 head=""; prev=""; for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
                 # Remember created PRs (pr list returns them): number, head branch, state OPEN.
                 node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const n=99+l.length;l.push({number:n,headRefName:process.argv[2],state:"OPEN",url:"https://github.com/owner/repo/pull/"+n});fs.writeFileSync(f,JSON.stringify(l));console.log(l.at(-1).url)' "$FAKE_GH_LOG.prs.json" "$head" | tee "$FAKE_GH_LOG.pr" ;;
  "pr view")
    case "$*" in
      *reviewDecision*) echo "${FAKE_GH_REVIEW_DECISION:-}" ;;
      *comments,reviews,commits*) printf '%s' "${FAKE_GH_PR_VIEW:-{\"comments\":[],\"reviews\":[],\"commits\":[]\}}" ;;
      *reviews,comments*) printf '%s\n' "${FAKE_GH_PR_COMMENTS:---- alice:\nplease rename x}" ;;
      *number,title,body*) echo "# PR #$3 Some change" ;;
      *url*) [ -f "$FAKE_GH_LOG.pr" ] && cat "$FAKE_GH_LOG.pr" || exit 1 ;;
      *) exit 1 ;;
    esac ;;
  "pr checks")
    n=$(($(cat "$FAKE_GH_LOG.checks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_GH_LOG.checks"
    if [ -n "$FAKE_GH_CI_FAILS" ] && [ "$n" -le "$FAKE_GH_CI_FAILS" ]; then echo "test  fail  1m"; exit 1; fi
    echo "test  pass  1m" ;;
  "run list")    case "$*" in *workflowName*) printf '%s' "${FAKE_GH_RUNS:-[]}" ;; *) echo 123 ;; esac ;;
  "run view")    echo "FAIL src/app.test.js: expected 2, got 3" ;;
  "pr merge")    echo "merged" ;;
  "pr checkout") git fetch -q origin "factory/pr-$3" && git checkout -q -B "factory/pr-$3" FETCH_HEAD && git branch -q --set-upstream-to="origin/factory/pr-$3" 2>/dev/null; git config "branch.factory/pr-$3.remote" origin; git config "branch.factory/pr-$3.merge" "refs/heads/factory/pr-$3" ;;
  "api "*)       case "$2" in user) echo "${FAKE_GH_LOGIN:-foundry-owner}" ;; *permission*) l=${2#*collaborators/}; l=${l%/permission}
                       # $FAKE_GH_READONLY: logins that only have read access
                       case " $FAKE_GH_READONLY " in *" $l "*) echo read ;; *) echo "${FAKE_GH_PERMISSION:-write}" ;; esac ;; *) printf '%s' "${FAKE_GH_API:-[]}" ;; esac ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac
