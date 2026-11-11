// Translation audit: opens every screen in English and lists the Italian strings that found no translation.
const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.addInitScript(() => { window.__miss = new Set(); });
  await p.goto('http://localhost:8787/'); await p.fill('#pw', 'test-pass'); await p.click('#loginForm button'); await p.waitForSelector('#newBody');
  const api = (path, method, body) => p.evaluate(([path, method, body]) => fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json()), [path, method, body]);
  await api('/settings', 'PUT', { language: 'en', ai_drafts: true }); await api('/alerts/test', 'POST');
  await p.reload(); await p.waitForSelector('#newBody'); await p.waitForTimeout(1200);
  const open = async (sel) => { const el = p.locator(sel).first(); if (await el.count()) { await el.click(); await p.waitForTimeout(600); await p.keyboard.press('Escape'); await p.waitForTimeout(300); } };
  await open('#view .draft'); await open('#view .slot.full'); await open('#view .slot.free[data-ts]:not(.past)'); await open('#view [data-day]');
  await p.fill('#newBody', 'x'); await p.click('#addWhen'); await p.waitForTimeout(500); await p.keyboard.press('Escape');
  for (const t of ['generate', 'voice', 'materials', 'stats', 'activity', 'people', 'feed', 'settings']) {
    await p.click(`[data-tab=${t}]`); await p.waitForTimeout(1800);
    if (t === 'generate') await p.click('[data-m=full]');
    if (t === 'materials') { await p.click('#mNew'); await p.waitForTimeout(400); await p.keyboard.press('Escape'); }
    if (t === 'stats') { for (const d of [0.6, 3650]) { await p.evaluate((d) => { statDays = d; render(); }, d); await p.waitForTimeout(1500); } }
    if (t === 'feed') { await p.click('[data-ft=insp]'); await p.waitForTimeout(700); }
    if (t === 'people') { for (const pt of ['suggested', 'all', 'circle']) { await p.click(`[data-pt=${pt}]`); await p.waitForTimeout(600); } await open('[data-open]'); const o = p.locator('[data-open]').first(); if (await o.count()) { await o.click(); await p.waitForTimeout(600); await p.keyboard.press('Escape'); }
      await p.click('[data-side=creators]'); await p.waitForTimeout(900); await p.click('[data-side=subs]'); await p.waitForTimeout(500); }
    if (t === 'settings') { await p.click('#sTest'); await p.waitForTimeout(4500); }
  }
  const miss = await p.evaluate(() => [...window.__miss]);
  const junk = /^[\d\s.,:%+×·|()\/-]+$|^@|^https?:|orelzilberman|^[A-Z][a-z]{2} \d|^\d+ [A-Z][a-z]{2}|UTC/;
  const out = miss.filter(m => !junk.test(m)).sort();
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log(out.length, 'untranslated candidates'); console.log(out.map(x => ' - ' + x.slice(0, 110)).join('\n')); console.log('errors', errs);
  await api('/settings', 'PUT', { language: 'it' }); await api('/alerts/seen', 'POST', {}); await b.close();
})();
