#!/bin/bash
COOKIE='connect.sid=s%3AnkHki0PXSGacpyQPPQ-qtJozwJM2VY_r.QyCu5Kygkokyug0KeSptkb3j4Ggr09N1GDd63XvrRew'
run(){
  name=$1; url=$2
  echo "=== $name $url $(date +%H:%M:%S) ==="
  npx --yes lighthouse "$url" \
    --only-categories=accessibility \
    --output=json --output-path="lh-$name.json" --quiet \
    --extra-headers="{\"Cookie\":\"$COOKIE\"}" \
    --chrome-flags="--headless=new --no-sandbox --disable-gpu" \
    --max-wait-for-load=45000 >/dev/null 2>&1
  if [ -f "lh-$name.json" ]; then
    node -e "
      const r=require('./lh-$name.json');
      const score=Math.round((r.categories.accessibility.score||0)*100);
      const fails=Object.values(r.audits).filter(a=>a.score!==null&&a.score<1&&r.categories.accessibility.auditRefs.some(x=>x.id===a.id)).map(a=>a.id);
      console.log(JSON.stringify({page:'$name',finalUrl:r.finalDisplayedUrl||r.finalUrl,score,failedAudits:fails}));
    "
  else echo "{\"page\":\"$name\",\"error\":\"no output\"}"; fi
}
run login    http://localhost:5173/login
run my-week  http://localhost:5173/my-week
run docs     http://localhost:5173/docs
run team     http://localhost:5173/team/directory
