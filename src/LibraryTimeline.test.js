import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';

// Compile the real component with Vue's bundled compiler; no browser or test-only dependency needed.
const filename = new URL('./LibraryTimeline.vue', import.meta.url);
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname });
const compiled = compileScript(descriptor, { id: 'timeline-test', inlineTemplate: true, templateOptions: { ssr: true } });
const source = compiled.content.replace(/from ["'](vue(?:\/server-renderer)?)["']/g,
  (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { default: LibraryTimeline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

async function render(props = {}) {
  const days = [
    { date: '2024-01-01', count: 1, public_count: 1 },
    { date: '2024-01-02', count: 3, public_count: 2 },
    { date: '2024-01-03', count: 2, public_count: 0 },
    { date: '2024-01-04', count: 1 },
    { date: '2023-12-31', count: 1, public_count: 1 },
  ];
  const app = createSSRApp(LibraryTimeline, {
    timeZone: 'America/Detroit', year: 2024,
    timeline: { days, total: 8, first_date: '2023-12-31', last_date: '2024-01-04' },
    ...props,
  });
  app.component('v-btn', { setup: (_, { slots }) => () => h('button', slots.default?.()) });
  app.component('v-progress-linear', { render: () => h('div') });
  return renderToString(app);
}
function dayButton(html, date) {
  const buttons = html.match(/<button\b[^>]*class="[^"]*\bcalendar-day\b[^>]*>.*?<\/button>/gs) || [];
  const button = buttons.find(button => button.includes(`aria-label="${date} `));
  assert.ok(button, `Missing day ${date}`);
  return button;
}

test('timeline renders one decorative star per public day and announces public counts', async () => {
  const html = await render();
  assert.equal((html.match(/class="[^"]*\bcalendar-day\b/g) || []).length, 366);
  for (const [date, label] of [['2024-01-01', '1 song · 1 public song'], ['2024-01-02', '3 songs · 2 public songs']]) {
    const button = dayButton(html, date);
    assert.equal((button.match(/class="release-star"/g) || []).length, 1);
    assert.ok(button.includes(`aria-label="${date} America/Detroit: ${label}"`));
    assert.ok(button.includes(`title="${date} America/Detroit: ${label}"`));
    assert.match(button, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  }
  for (const date of ['2024-01-03', '2024-01-04', '2024-01-05']) {
    assert.doesNotMatch(dayButton(html, date), /release-star|public song/);
  }
  assert.equal((html.match(/class="release-star"/g) || []).length, 3, 'Two public days and one legend star');
});

test('public days retain selected/loading semantics and use only the displayed year', async () => {
  const html = await render({ selectedDay: '2024-01-02', loading: true });
  const selected = dayButton(html, '2024-01-02');
  assert.match(selected, /selected-day/);
  assert.match(selected, /aria-pressed="true"/);
  assert.match(selected, /disabled/);
  assert.match(html, /2024-01-02 America\/Detroit · 3 songs captured/);
  const previous = await render({ year: 2023 });
  assert.match(dayButton(previous, '2023-12-31'), /release-star/);
  assert.equal((previous.match(/class="release-star"/g) || []).length, 2, 'One public day and one legend star');
});
