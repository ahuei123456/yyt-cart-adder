export const styles = `
:host { all: initial; color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
button, textarea, input { font: inherit; }
.launcher { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; border: 0; border-radius: 999px; padding: 12px 18px; background: #17365d; color: #fff; font: 700 14px/1.2 system-ui, sans-serif; box-shadow: 0 4px 16px #0004; cursor: pointer; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 18px; background: #10182899; font: 14px/1.45 system-ui, sans-serif; color: #182230; }
.backdrop[hidden] { display: none; }
.panel { width: min(1050px, 100%); max-height: min(90vh, 900px); overflow: auto; border-radius: 14px; background: #fff; box-shadow: 0 20px 60px #0007; }
.header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #d8dee8; background: #fff; }
h2, h3, p { margin: 0; }
h2 { font-size: 20px; }
h3 { margin-bottom: 10px; font-size: 17px; }
.body { padding: 20px; }
.view { display: grid; gap: 16px; }
.hint { color: #475467; }
.warning { padding: 10px 12px; border-left: 4px solid #b54708; background: #fff4e8; font-weight: 650; }
.error { padding: 10px 12px; border-left: 4px solid #b42318; background: #fef3f2; color: #912018; white-space: pre-wrap; }
label { display: grid; gap: 7px; font-weight: 650; }
textarea { width: 100%; min-height: 220px; resize: vertical; border: 1px solid #98a2b3; border-radius: 8px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 400; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
button { border: 1px solid #98a2b3; border-radius: 7px; padding: 9px 13px; background: #fff; color: #182230; cursor: pointer; }
button.primary { border-color: #17365d; background: #17365d; color: #fff; font-weight: 700; }
button.danger { border-color: #b42318; color: #b42318; }
button:disabled { cursor: not-allowed; opacity: .48; }
button:focus-visible, textarea:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid #84caff; outline-offset: 2px; }
.close { padding: 5px 9px; font-size: 18px; }
.table-wrap { overflow-x: auto; border: 1px solid #d8dee8; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 9px; border-bottom: 1px solid #e4e7ec; text-align: left; vertical-align: top; }
th { background: #f7f9fc; white-space: nowrap; }
tr.partial { background: #fff8e8; }
tr.unavailable { color: #667085; background: #f8fafc; }
.num { text-align: right; white-space: nowrap; }
.status { font-weight: 700; }
.summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 12px; border-radius: 8px; background: #f1f5f9; }
.progress { width: 100%; height: 12px; }
.result-group { padding: 12px; border: 1px solid #d8dee8; border-radius: 8px; }
.result-group ul { margin: 8px 0 0; padding-left: 20px; }
a { color: #175cd3; }
@media (max-width: 600px) { .backdrop { padding: 0; place-items: stretch; } .panel { width: 100%; max-height: 100vh; border-radius: 0; } .body { padding: 14px; } .launcher { right: 10px; bottom: 10px; } }
`;
