// 레시피 1호의 화면 읽기: 사용량 화면을 열고 "Weekly quota NN% used … Resets in …" 글자만 읽는다. 아무것도 누르지 않는다.
const p = await openTab("https://app.devin.ai/org/lshindo32-beep/settings/usage");
let t = "";
for (let i = 0; i < 40; i++) {
  t = await p.evaluate(() => document.body.innerText);
  if (/Weekly quota[\s\S]{0,40}% used/.test(t)) break;
  await sleep(500);
}
const m = t.match(/Weekly quota\s*([\d.]+)% used[\s\S]{0,80}?(Resets in [^\n]+)/);
console.log("RESULT " + JSON.stringify(m ? { used: m[1], reset: m[2] } : null));
await closeTab(p);
