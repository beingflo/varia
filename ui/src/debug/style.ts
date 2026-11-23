// Styling for the debug overlay lives here as a string and is injected into its shadow root,
// so nothing here can leak into the app and the app's CSS cannot reach it.
export const DEBUG_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column;
  background: #101012; color: #d8d8d4; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  border-top: 2px solid #444;
}
header {
  display: flex; align-items: center; gap: .75rem; padding: .4rem .7rem;
  border-bottom: 1px solid #2c2c2e; flex: none;
}
header .name { color: #fff; letter-spacing: .04em; }
header .hint { color: #6d6d70; margin-left: auto; }
button {
  font: inherit; color: #d8d8d4; background: none; border: 1px solid #3a3a3c;
  border-radius: 4px; padding: 0 .45rem; cursor: pointer;
}
button:hover { border-color: #6d6d70; }
button.on { border-color: #8a8a8f; color: #fff; }
.body { display: flex; flex: 1; min-height: 0; }
nav { width: 15rem; flex: none; border-right: 1px solid #2c2c2e; overflow: auto; padding: .3rem 0; }
nav button { display: flex; justify-content: space-between; width: 100%; border: none; border-radius: 0; padding: .2rem .7rem; text-align: left; }
nav button .count { color: #6d6d70; }
nav button.on { background: #1d1d20; color: #fff; }
main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: .5rem; align-items: center; padding: .35rem .6rem; border-bottom: 1px solid #2c2c2e; flex: none; }
.toolbar .muted { color: #6d6d70; }
.probe { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .35rem .6rem; border-bottom: 1px solid #2c2c2e; flex: none; }
.probe input { font: inherit; color: inherit; background: #16161a; border: 1px solid #3a3a3c; border-radius: 4px; padding: .1rem .4rem; width: 18rem; }
.probe .muted { color: #9a9a9f; }
.probe .plan { color: #6d6d70; width: 100%; }
.scroll { flex: 1; overflow: auto; }
table { border-collapse: collapse; font-size: 11.5px; width: max-content; min-width: 100%; }
th, td { text-align: left; padding: .12rem .55rem; border-bottom: 1px solid #202023; vertical-align: top; white-space: nowrap; max-width: 26rem; overflow: hidden; text-overflow: ellipsis; }
th { position: sticky; top: 0; background: #16161a; color: #9a9a9f; font-weight: normal; }
tbody tr:hover { background: #1b1b1f; }
tbody tr.on { background: #232329; }
td.null { color: #5a5a5e; }
td.num { color: #8fb8d8; }
.detail { flex: none; max-height: 40%; overflow: auto; border-top: 1px solid #2c2c2e; padding: .5rem .7rem; background: #0c0c0e; }
.detail pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.key { color: #9fb89f; } .str { color: #d8c08f; } .lit { color: #b08fb8; }
.empty { color: #6d6d70; padding: .8rem; }
.error { color: #e08080; padding: .8rem; white-space: pre-wrap; }
`;
