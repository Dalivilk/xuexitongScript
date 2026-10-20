import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../v3_optimized.js', import.meta.url), 'utf8');
const start = source.indexOf('const app = {') + 'const app = '.length;
const end = source.indexOf('\n        window.app = app;', start);
const object = source.slice(start, end).trim().replace(/;$/, '');
const makeApp = ($ = () => {}, globals = {}) => vm.runInNewContext(`(${object})`, {
    console: { log() {}, warn() {}, error() {} }, $, setTimeout, clearTimeout, ...globals,
    document: globals.document || { querySelectorAll: () => [], querySelector: () => null },
});
const app = makeApp();
const collection = items => ({ length: items.length, get: i => items[i] });
let clicked;
let refreshes = 0;
let lessons = [collection(['first', 'second', 'third']), collection(['fourth'])];
app._getTreeContainer = () => ({});
app._getChapterNodes = () => collection([0, 1]);
app._getLessonNodes = chapter => lessons[chapter];
app._initCellData = () => { refreshes++; app._currentNodeFound = true; };
app.playCurrentIndex = node => { clicked = node ?? lessons[app.cellData.currentCellIndex].get(app.cellData.currentNCellIndex); };
app.cellData.nCells = 4;
app.cellData.currentNCellIndex = 1;
await app.nextUnit();
assert.equal(clicked, 'third', 'advance from the active lesson to the next lesson');
assert.equal(refreshes, 1, 'refresh active lesson before navigation');
assert.equal(app._nextUnitPending, false);
app.cellData.currentNCellIndex = 2;
await app.nextUnit();
assert.equal(clicked, 'fourth', 'advance across chapter boundary');
clicked = null;
await app.nextUnit();
assert.equal(clicked, null, 'last lesson does not click another node');
assert.equal(app._nextUnitPending, false, 'end of directory releases navigation lock');
app._getChapterNodes = () => collection([]);
app.cellData.nCells = 0;
await app.nextUnit();
assert.equal(clicked, null, 'unrecognized directory does not navigate');
assert.equal(app._nextUnitPending, false, 'directory error releases navigation lock');
app._initCellData = () => { app._currentNodeFound = false; };
await app.nextUnit();
assert.equal(app._nextUnitPending, false, 'unknown current lesson releases navigation lock');

// 侧栏高亮变了但播放器未变时，不应重播旧视频。
function transitionFixture({ neverLoads = false, reusedElement = false, preloadNone = false } = {}) {
    const oldVideo = { currentSrc: 'old.mp4', readyState: 1, ended: true };
    const newVideo = { currentSrc: 'new.mp4', readyState: preloadNone ? 0 : 1, ended: false };
    let nativeClicks = 0;
    let plays = 0;
    let polls = 0;
    const link = { click() { nativeClicks++; } };
    const target = {};
    const wrapped = {
        find: () => collection([link]),
        attr: () => '下一小节',
        hasClass: name => name === 'currents',
    };
    const player = makeApp(() => wrapped);
    player.configs.navigationPollMs = 1;
    player.configs.navigationTimeoutMs = neverLoads ? 10 : 1000;
    player._detachVideoEvents = () => {};
    player._initCellData = () => {};
    player._getVideoEl = () => {
        polls++;
        if (neverLoads || polls < 4) return oldVideo;
        if (reusedElement) {
            oldVideo.currentSrc = 'new.mp4';
            oldVideo.ended = false;
            return oldVideo;
        }
        return newVideo;
    };
    player.play = () => {
        assert.ok(polls >= 4, 'do not play while only the old video is present');
        assert.equal(player._navigationLoading, false);
        plays++;
    };
    return { player, target, stats: () => ({ nativeClicks, plays, polls }) };
}
for (const reusedElement of [false, true]) {
    const fixture = transitionFixture({ reusedElement });
    await fixture.player.playCurrentIndex(fixture.target);
    assert.equal(fixture.stats().nativeClicks, 1, 'use the native DOM click');
    assert.equal(fixture.stats().plays, 1, 'play after a new video/source is confirmed');
}
const preloadNone = transitionFixture({ preloadNone: true });
await preloadNone.player.playCurrentIndex(preloadNone.target);
assert.equal(preloadNone.stats().plays, 1, 'new source may require play() before metadata can load');
const stuck = transitionFixture({ neverLoads: true });
await assert.rejects(stuck.player.playCurrentIndex(stuck.target), /未确认目标小节/);
assert.equal(stuck.stats().plays, 0, 'timeout must not replay the old video');
assert.equal(stuck.player._navigationFailed, true);
assert.equal(stuck.player._navigationLoading, false);

// 等待内容更新时，重复的下一节调用应被拦住；加载完成后释放。
const locked = makeApp();
locked._getTreeContainer = () => ({});
locked._getChapterNodes = () => collection([0]);
locked._getLessonNodes = () => collection(['first', 'second']);
locked._initCellData = () => { locked._currentNodeFound = true; };
locked.cellData.nCells = 2;
let release;
let navigationCalls = 0;
locked.playCurrentIndex = () => { navigationCalls++; return new Promise(resolve => { release = resolve; }); };
const navigation = locked.nextUnit();
assert.equal(locked._nextUnitPending, true);
await locked.nextUnit();
assert.equal(navigationCalls, 1);
release();
await navigation;
assert.equal(locked._nextUnitPending, false);

// ended 状态也通常是 paused，必须先处理结束，不能先恢复播放。
const ended = makeApp();
ended._getVideoEl = () => ({ paused: true, ended: true });
ended._isPlaying = true;
let handledEnd = false;
ended._handleVideoEnded = () => { handledEnd = true; };
ended._tryResumePlayback = () => assert.fail('must not resume an ended video');
ended._checkVideoStatus();
assert.equal(handledEnd, true);

// 新页初始化时 iframe 尚未创建，仍应等待并接管稍后出现的播放器。
const startup = makeApp();
let scans = 0;
let playCalls = 0;
const delayedVideo = { ended: false, async play() { playCalls++; } };
startup.configs.retryInterval = 1;
startup._getVideoEl = () => (++scans < 3 ? null : delayedVideo);
startup._currentStepTitle = () => '';
startup._advanceLearningStep = () => false;
startup._isChapterTest = () => false;
startup._videoEventHandle = () => {};
const startupDone = new Promise(resolve => { startup._startVideoMonitoring = resolve; });
await startup.play();
await Promise.race([startupDone, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('delayed startup did not recover')), 1000);
    timeout.unref();
})]);
assert.equal(playCalls, 1);
assert.equal(startup._tryTimes, 0, 'successful startup resets retries');

// 浏览器拒绝有声自动播放时，现有静音回退仍须成功。
const fallback = makeApp();
let attempts = 0;
const blockedVideo = {
    ended: false,
    muted: false,
    async play() {
        attempts++;
        if (!this.muted) throw new Error('NotAllowedError');
    },
};
fallback._getVideoEl = () => blockedVideo;
fallback._videoEventHandle = () => {};
const fallbackDone = new Promise(resolve => { fallback._startVideoMonitoring = resolve; });
await fallback.play();
await fallbackDone;
assert.equal(attempts, 2);
assert.equal(blockedVideo.muted, true);

// 未命名的包装 iframe 与跨域 iframe 不能挡住后面的有效视频。
const doc = (video, frames = []) => ({ querySelector: () => video, querySelectorAll: () => frames });
const inaccessible = { get contentDocument() { throw new Error('SecurityError'); } };
let activeDocument = doc(delayedVideo);
const videoFrame = { get contentDocument() { return activeDocument; } };
const page = doc(null, [inaccessible, { contentDocument: doc(null, [videoFrame]) }]);
const finder = makeApp(undefined, { document: page });
assert.equal(finder._getVideoEl(), delayedVideo);
activeDocument = doc(blockedVideo);
assert.equal(finder._getVideoEl(), blockedVideo, 'do not retain a video in the previous iframe document');

// 文字页先等待，满 5 秒且没有播放器占位时才进入下一节。
let now = 100;
const noVideo = makeApp(undefined, { Date: { now: () => now } });
noVideo._getVideoEl = () => null;
noVideo._advanceLearningStep = () => false;
noVideo._getCourseDocuments = () => [{ readyState: 'complete', querySelector: () => null }];
let skipped = 0;
let retries = 0;
noVideo.nextUnit = async () => { skipped++; };
noVideo._schedulePlayRetry = () => { retries++; };
await noVideo.play();
assert.equal(skipped, 0, 'initially missing video must not skip the lesson immediately');
now = 5099;
await noVideo.play();
assert.equal(skipped, 0);
now = 5100;
await noVideo.play();
assert.equal(skipped, 1, 'skip a confirmed non-video page after the wait');
assert.equal(retries, 2);

// 有播放器占位时，即使等满时间，也不能当作文字页跳过。
noVideo._noVideoSince = 100;
noVideo._getCourseDocuments = () => [{ readyState: 'complete', querySelector: () => ({}) }];
await noVideo.play();
assert.equal(skipped, 1, 'a pending video frame must not be skipped');
noVideo._getCourseDocuments = () => [{ readyState: 'loading', querySelector: () => null }];
await noVideo.play();
assert.equal(skipped, 1, 'a loading document must not be skipped');
noVideo.configs.autoAdvanceNoVideo = false;
noVideo._isChapterTest = () => false;
noVideo._getCourseDocuments = () => [{ readyState: 'complete', querySelector: () => null }];
await noVideo.play();
assert.equal(skipped, 1, 'automatic skip can be disabled');

// 学习目标页存在“视频”页签时，先点击它，不直接跳整个小节。
const steps = makeApp();
let tabClicks = 0;
const tab = { textContent: ' 2 视频 ', click() { tabClicks++; } };
steps._getStepTabs = () => [tab];
steps._currentStepTitle = () => '学习目标';
steps._getVideoEl = () => null;
steps._schedulePlayRetry = () => {};
steps.nextUnit = () => assert.fail('video tab should be tried before skipping the lesson');
await steps.play();
await steps.play();
assert.equal(tabClicks, 1, 'do not repeatedly click a tab while it is loading');

// 下一小节落在无视频的学习目标页时，允许交回主流程选择页签。
for (const previouslyHadVideo of [true, false]) {
    let clicked = false;
    let resumed = false;
    const oldDocument = { readyState: 'complete', URL: 'course/old', body: { textContent: '旧内容' } };
    const newDocument = { readyState: 'complete', URL: 'course/new', body: { textContent: '学习目标' } };
    const link = { click() { clicked = true; } };
    const wrapper = { find: () => collection([link]), attr: () => '目标小节', hasClass: () => clicked };
    const landing = makeApp(() => wrapper);
    landing._getVideoEl = () => !clicked && previouslyHadVideo ? { currentSrc: 'old.mp4' } : null;
    landing._getCourseDocuments = () => [clicked ? newDocument : oldDocument];
    landing._detachVideoEvents = () => {};
    landing._initCellData = () => {};
    landing.play = () => { resumed = true; };
    await landing.playCurrentIndex({});
    assert.equal(resumed, true, 'non-video landing page should not cause navigation failure');
    assert.equal(landing._navigationFailed, false);
}
console.log('Navigation, autoplay and non-video-page checks passed.');
