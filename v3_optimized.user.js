// ==UserScript==
// @name         学习通自动刷课脚本 V3 稳定版
// @namespace    local.codex.xuexitong
// @version      3.3.4
// @description  自动播放、自动切换下一节，并在页面结构异常时安全停止
// @author       Codex
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    const APP_KEY = '__xuexitongPlayerV3';
    const BOOT_TIMER_KEY = '__xuexitongPlayerV3BootTimer';

    const previousApp = window[APP_KEY];
    if (previousApp && typeof previousApp.destroy === 'function') {
        previousApp.destroy();
    }
    if (window[BOOT_TIMER_KEY]) {
        clearInterval(window[BOOT_TIMER_KEY]);
        window[BOOT_TIMER_KEY] = null;
    }

    if (typeof window.jQuery === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
        script.type = 'text/javascript';
        script.onload = function () {
            console.log("jQuery loaded.");
            waitForCoursePage();
        };
        document.head.appendChild(script);
    } else {
        waitForCoursePage();
    }

    function waitForCoursePage() {
        let attempts = 0;
        const maxAttempts = 20;
        window[BOOT_TIMER_KEY] = setInterval(() => {
            if ($('#coursetree').length > 0) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                initializePlayer();
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                console.error('%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。', 'color:#F44336;font-weight:bold');
            }
        }, 1000);
    }

    function initializePlayer() {
        const app = {
            configs: {
                playbackRate: 1,
                autoplay: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                autoAdvanceNoVideo: true,
                noVideoWaitMs: 5000,
                navigationTimeoutMs: 30000,
                navigationPollMs: 500,
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _currentRetryCount: 0,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _navigationLoading: false,
            _navigationFailed: false,
            _destroyed: false,
            _endedTimer: null,
            _noVideoSince: 0,
            _chapterAdvanceTimes: 0,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: "",
            },
            get cellData() {
                return this._cellData;
            },
            run() {
                this._destroyed = false;
                this._navigationFailed = false;
                if (this._navigationLoading) return;
                this._tryTimes = 0;
                this._noVideoSince = 0;
                this._stepAdvanceTimes = 0;
                this._stepSwitchPending = false;
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = null;
                if (this._endedTimer) clearTimeout(this._endedTimer);
                this._endedTimer = null;
                console.log("%c=== 学习通自动刷课脚本 V3 优化版启动 ===", "color:#4CAF50;font-size:16px;font-weight:bold");
                this._nextUnitPending = false;
                this._chapterAdvanceTimes = 0;
                this._getTreeContainer();
                this._initCellData();
                this._videoEl = null;
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this.play();
            },
            async nextUnit() {
                if (this._nextUnitPending) {
                    console.warn('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._nextUnitPending = true;
                if (this._endedTimer) clearTimeout(this._endedTimer);
                this._endedTimer = null;
                this._clearCheckInterval();
                console.log("%c=== 准备切换到下一小节 ===", "color:#2196F3;font-size:14px");
                try {
                    this._initCellData();
                    if (!this._currentNodeFound) throw new Error('未识别当前小节，已停止自动跳转。');
                    const el = this._getTreeContainer();
                    const cells = this._getChapterNodes();
                    if (cells.length === 0 || this._cellData.nCells === 0) {
                        throw new Error('课程目录结构未适配：未识别到章节或小节，不能判断课程已完成。');
                    }
                    const nCells = this._getLessonNodes(cells.get(this._cellData.currentCellIndex));

                    if (nCells.length > this._cellData.currentNCellIndex + 1) {
                        const nextNIndex = this._cellData.currentNCellIndex + 1;
                        console.log(`%c切换到同章节下一个视频: ${nextNIndex + 1}/${nCells.length}`, "color:#FF9800");
                        await this.playCurrentIndex(nCells.get(nextNIndex));
                    } else {
                        const nextIndex = this._cellData.currentCellIndex + 1;
                        if (nextIndex >= cells.length) {
                            console.log('%c已到课程目录末尾，自动切换已停止。任务完成情况请查看平台标记。', 'color:#4CAF50;font-size:16px');
                            return;
                        }
                        console.log(`%c切换到下一个章节: ${nextIndex + 1}/${cells.length}`, "color:#FF9800");
                        this._cellData.currentCellIndex = nextIndex;
                        this._cellData.currentNCellIndex = 0;
                        await this.playCurrentIndex();
                    }
                } catch (error) {
                    console.error('切换下一小节失败:', error);
                } finally {
                    this._nextUnitPending = false;
                }
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                }, this.configs.videoCheckInterval);
            },
            _tryResumePlayback(reason) {
                if (this._navigationLoading || this._navigationFailed || this._destroyed) return;
                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) {
                    return;
                }
                this._guardLastResumeTs = now;

                const video = this._getVideoEl();
                if (!video || !this._isPlaying || video.ended) return;

                console.log(`%c触发视频保活恢复(${reason})`, "color:#607D8B");
                video.play().catch((e) => {
                    console.warn("直接恢复播放失败，尝试静音恢复:", e);
                    video.muted = true;
                    video.play().catch((err) => {
                        console.error("静音恢复播放失败:", err);
                    });
                });
            },
            _checkVideoStatus() {
                try {
                    const video = this._getVideoEl();
                    if (!video) return;
                    if (video.ended && this._isPlaying) {
                        this._handleVideoEnded();
                        return;
                    }

                    if (video.paused && this._isPlaying) {
                        console.log("%c检测到视频暂停，尝试恢复播放...", "color:#FF5722");
                        this._tryResumePlayback("paused");
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
                                this._tryResumePlayback("no-progress");
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }

                } catch (e) {
                    console.error("视频状态检查失败:", e);
                }
            },
            _tryTimes: 0,
            _stepAdvanceTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _delayedNextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                if (this._navigationLoading || this._navigationFailed || this._destroyed) return;
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = null;
                try {
                    const el = this._getVideoEl();
                    if (el == null) {
                        if (!this._noVideoSince) this._noVideoSince = Date.now();
                        if (this._advanceLearningStep()) {
                            this._schedulePlayRetry('已尝试打开当前小节的视频页，等待播放器');
                            return;
                        }
                        if (!this.configs.autoAdvanceNoVideo && this._isChapterTest()) {
                            this._advanceChapterTest();
                            return;
                        }
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        const waited = Date.now() - this._noVideoSince >= this.configs.noVideoWaitMs;
                        if (this.configs.autoAdvanceNoVideo && waited && this._canAdvanceWithoutVideo()) {
                            console.warn('%c等待后仍未发现视频，按配置进入下一小节', 'color:#FF9800');
                            this._noVideoSince = 0;
                            await this.nextUnit();
                        } else {
                            this._schedulePlayRetry('当前页面的播放器尚未出现');
                        }
                        return;
                    }

                    this._noVideoSince = 0;
                    if (el.ended) {
                        this._handleVideoEnded();
                        return;
                    }
                    this._isPlaying = true;
                    this._videoEventHandle();
                    el.playbackRate = this.configs.playbackRate;

                    try {
                        await el.play();
                        if (this._navigationLoading || this._navigationFailed || this._destroyed) return;
                        this._tryTimes = 0;
                        console.log(`%c视频开始播放，倍速: ${el.playbackRate}x`, "color:#4CAF50");
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error("视频播放失败:", playError);
                        this._handlePlayError(playError);
                    }
                } catch (e) {
                    this._schedulePlayRetry(e.message || '播放器尚未就绪');
                }
            },
            _schedulePlayRetry(reason) {
                if (this._navigationLoading || this._navigationFailed || this._destroyed) return;
                if (this._tryTimes >= this.configs.maxRetries) {
                    console.error(`播放器启动已停止：${reason}。已达到最大重试次数，请检查页面或执行 app.run() 重试。`);
                    this._clearCheckInterval();
                    return;
                }
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                this._tryTimes++;
                console.log(`%c${reason}，${this.configs.retryInterval / 1000}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, 'color:#FF9800');
                this._delayedNextUnitTimer = setTimeout(() => {
                    this._delayedNextUnitTimer = null;
                    this.play();
                }, this.configs.retryInterval);
            },
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) {
                    return true;
                }

                const currentStepTitle = this._currentStepTitle();
                if (currentStepTitle === '视频' || this._stepAdvanceTimes >= 3) {
                    return false;
                }

                const videoTab = this._getStepTabs().find(el => this._stepLabel(el) === '视频');
                if (!videoTab) return false;
                this._stepSwitchPending = true;
                this._stepSwitchAt = Date.now();
                this._stepAdvanceTimes++;
                console.log('%c尝试点击当前小节的“视频”页签', 'color:#2196F3');
                videoTab.click();
                return true;
            },
            _stepLabel(el) {
                const text = (el.textContent || el.title || '').replace(/\s+/g, '');
                return text.replace(/^\d+[.、]?/, '');
            },
            _getStepTabs() {
                const selector = '.prev_white, .prev_title, [role="tab"], a, button, li, span, div';
                return Array.from(document.querySelectorAll(selector)).filter(el => {
                    if (!['学习目标', '视频', '章节测验'].includes(this._stepLabel(el))) return false;
                    if (el.closest('#coursetree') || el.getClientRects().length === 0) return false;
                    const style = el.ownerDocument.defaultView.getComputedStyle(el);
                    return style.visibility !== 'hidden' && style.display !== 'none';
                });
            },
            _currentStepTitle() {
                const prevTitle = document.getElementsByClassName('prev_title')[0];
                if (prevTitle) return this._stepLabel(prevTitle);
                const selected = this._getStepTabs().find(el =>
                    el.matches('[aria-selected="true"], .currents, .current, .active, .on, .selected') ||
                    el.parentElement?.matches('[aria-selected="true"], .currents, .current, .active, .on, .selected')
                );
                return selected ? this._stepLabel(selected) : '';
            },
            _canAdvanceWithoutVideo() {
                const docs = this._getCourseDocuments();
                if (docs.some(doc => doc.readyState === 'loading')) return false;
                // 播放器框架已经存在时，应等待或报告加载失败，不能当作无视频页面跳过。
                return !docs.some(doc => doc.querySelector('video, iframe.ans-insertvideo-online, iframe[src*="/video"]'));
            },
            _isChapterTest() {
                return this._currentStepTitle() === '章节测验';
            },
            _advanceChapterTest() {
                if (this._chapterAdvanceTimes >= 3) {
                    console.error('%c章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后执行 app.run()。', 'color:#F44336;font-weight:bold');
                    return;
                }

                const nextButton = $('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
                if (!nextButton) {
                    console.warn('%c未找到章节测验的下一步按钮，已停止。', 'color:#FF9800');
                    return;
                }

                this._chapterAdvanceTimes++;
                console.log('%c检测到章节测验，尝试进入下一学习步骤', 'color:#607D8B');
                nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                setTimeout(() => this.play(), 2000);
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) {
                    return;
                }
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    this._videoEl = null;
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    setTimeout(() => {
                        try {
                            this._initCellData();
                        } catch (e) {}
                        this.play();
                    }, 1800);
                };

                $(document).off('click.xuexitongPlayerV3', '.prev_white').on('click.xuexitongPlayerV3', '.prev_white', (e) => {
                    const text = ($(e.currentTarget).text() || "").replace(/\s+/g, "");
                    if (text.includes("视频")) {
                        console.log(`%c检测到步骤切换点击：${text}，准备重新接管视频页`, "color:#607D8B");
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                if (this._navigationLoading || this._navigationFailed || this._destroyed) return;
                console.error("播放错误详情:", error);
                const video = this._getVideoEl();
                if (video) {
                    video.muted = true;
                    video.play().then(() => {
                        console.log("%c静音播放成功", "color:#4CAF50");
                        this._tryTimes = 0;
                        this._startVideoMonitoring();
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                            this._delayedNextUnitTimer = null;
                        }
                    }).catch(e => {
                        console.error("静音播放也失败:", e);
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                        }
                        this._isPlaying = false;
                        if (this._tryTimes >= this.configs.maxRetries) {
                            console.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                            return;
                        }
                        this._tryTimes++;
                        this._delayedNextUnitTimer = setTimeout(() => {
                            this._delayedNextUnitTimer = null;
                            this.play();
                        }, this.configs.retryInterval);
                    });
                }
            },
            async playCurrentIndex(nCell) {
                if (!nCell) {
                    const el = this._getTreeContainer();
                    const cells = this._getChapterNodes();
                    const nCells = this._getLessonNodes(cells.get(this._cellData.currentCellIndex));
                    nCell = nCells.get(this._cellData.currentNCellIndex);
                }

                const $nCell = $(nCell);
                const clickableSpan = $nCell.find('.posCatalog_name, a[href*="getTeacherAjax"]').get(0);
                if (!clickableSpan) {
                    throw new Error('找不到可点击的课程节点，已停止切换。');
                }

                const previousVideo = this._getVideoEl();
                const previous = {
                    video: previousVideo,
                    source: this._videoSource(previousVideo),
                    documents: this._getCourseDocuments(),
                };
                this._noVideoSince = 0;
                this._tryTimes = 0;
                this._stepAdvanceTimes = 0;
                this._stepSwitchPending = false;
                this._navigationLoading = true;
                this._navigationFailed = false;
                this._isPlaying = false;
                this._clearCheckInterval();
                this._detachVideoEvents();
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                this._delayedNextUnitTimer = null;
                console.log(`%c点击切换到: ${$(clickableSpan).attr('title') || '未知标题'}`, "color:#2196F3");
                try {
                    // 原生点击会执行 javascript: 链接，不能仅触发目录的 jQuery 事件。
                    clickableSpan.click();
                    console.log('%c等待目标小节内容更新，期间不会重播旧视频...', 'color:#FF9800');
                    await this._waitForLessonVideo(nCell, previous);
                    this._initCellData();
                } catch (error) {
                    this._navigationFailed = true;
                    throw error;
                } finally {
                    this._navigationLoading = false;
                }
                if (this.configs.autoplay) await this.play();
            },
            _videoSource(video) {
                return video ? (video.currentSrc || video.getAttribute('src') || video.querySelector('source')?.src || '') : '';
            },
            async _waitForLessonVideo(target, previous) {
                const deadline = Date.now() + this.configs.navigationTimeoutMs;
                while (Date.now() < deadline && !this._destroyed) {
                    // 每轮重新从当前 iframe 中找视频，不沿用已导航页面的缓存。
                    this._videoEl = null;
                    const video = this._getVideoEl();
                    const currentTarget = (target.id && target.ownerDocument?.getElementById(target.id)) || target;
                    const selected = $(currentTarget).hasClass('currents') || $(currentTarget).hasClass('posCatalog_active');
                    const source = this._videoSource(video);
                    const changed = video && (video !== previous.video || (source && source !== previous.source));
                    // preload=none 的新视频可能一直保持 readyState=0，先调用 play() 才会加载元数据。
                    if (selected && changed && (source || video.readyState >= 1) && !video.ended) return video;
                    if (selected && !video) {
                        const documents = this._getCourseDocuments();
                        const newContent = documents.some(doc =>
                            !previous.documents.includes(doc) && doc.readyState !== 'loading' &&
                            doc.URL !== 'about:blank' && doc.body?.textContent.trim()
                        );
                        // 下一小节可能先显示学习目标，交回 play() 选择页签或等待后跳过。
                        if (previous.video || newContent) return null;
                    }
                    await new Promise(resolve => setTimeout(resolve, this.configs.navigationPollMs));
                }
                throw new Error('未确认目标小节的新视频加载，已停止，避免重复播放旧视频。请手动打开目标小节后执行 app.run()。');
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = this._getChapterNodes();
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;

                cells.each((i, v) => {
                    const nCells = this._getLessonNodes(v);
                    nCellCounts += nCells.length;
                    nCells.each((j, e) => {
                        const _el = $(e);
                        if (_el.hasClass("posCatalog_active") || _el.hasClass('currents')) {
                            this._cellData.currentCellIndex = i;
                            this._cellData.currentNCellIndex = j;
                            foundCurrent = true;
                            const titleSpan = _el.find('.posCatalog_name, a[title]')[0];
                            if (titleSpan) {
                                this._cellData.currentVideoTitle = $(titleSpan).attr('title');
                            }
                        }
                    });
                });

                this._cellData.nCells = nCellCounts;
                this._currentNodeFound = foundCurrent;

                if (!foundCurrent && nCellCounts > 0) {
                    console.warn("%c未找到当前激活的视频节点，可能需要手动选择", "color:#FF9800");
                }

                console.log(`%c课程信息: ${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`, "color:#607D8B");
            },
            _getTreeContainer() {
                if (!this._treeContainerEl || !this._treeContainerEl.get(0)?.isConnected) {
                    const el = $('#coursetree');
                    if (el.length <= 0) {
                        throw new Error("找不到视频列表");
                    }
                    this._treeContainerEl = el;
                }
                return this._treeContainerEl;
            },
            _getChapterNodes() {
                const tree = this._getTreeContainer();
                const legacy = tree.children('.cells');
                return legacy.length ? legacy : tree.children('ul').children('li');
            },
            _getLessonNodes(chapter) {
                const node = $(chapter);
                const legacy = node.find('.ncells h4[id^="cur"]');
                return legacy.length ? legacy : node.find('.posCatalog_select:not(.firstLayer)');
            },
            _getCourseDocuments() {
                const documents = [];
                const visit = (doc, depth) => {
                    if (!doc || depth > 4) return;
                    documents.push(doc);
                    for (const frame of doc.querySelectorAll('iframe')) {
                        try {
                            const frameDocument = frame.contentDocument || frame.contentWindow?.document;
                            visit(frameDocument, depth + 1);
                        } catch (error) {
                            // 单个跨域或正在加载的 iframe 不应阻止检查其他播放器。
                        }
                    }
                };
                visit(document, 0);
                return documents;
            },
            _getVideoEl() {
                // 从当前文档重查，避免导航后仍返回旧 iframe 文档中的缓存视频。
                this._videoEl = null;
                for (const doc of this._getCourseDocuments()) {
                    const video = doc.querySelector('video#video_html5_api, video[id*="video_html5"]') || doc.querySelector('video');
                    if (video) {
                        this._videoEl = video;
                        break;
                    }
                }
                return this._videoEl;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    console.log("videoEl未加载");
                    return;
                }

                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                };

                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
            },
            _detachVideoEvents() {
                if (!this._eventVideoEl || !this._boundVideoHandlers) return;
                this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
            },
            _handleVideoEnded(e) {
                if (this._endedTimer || this._navigationLoading || this._navigationFailed || this._destroyed) return;
                const title = this._cellData.currentVideoTitle;
                console.warn(`%c============'${title}' 播放完成=============`, "color:#4CAF50;font-weight:bold");
                this._isPlaying = false;
                this._clearCheckInterval();
                this._endedTimer = setTimeout(() => {
                    this._endedTimer = null;
                    this.nextUnit();
                }, 1000);
            },
            _handleVideoLoaded(e) {
                console.log(`%c============视频加载完成=============`, "color:#2196F3");
                if (this.configs.autoplay && !this._isPlaying) {
                    this.play();
                }
            },
            _handleVideoPlay(e) {
                const title = this._cellData.currentVideoTitle;
                console.info(`%c============'${title}' 开始播放=============`, "color:#4CAF50");
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const video = this._getVideoEl();
                this._guardLastTime = Number(video?.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            },
            _handleVideoPause(e) {
                console.log(`%c============视频暂停=============`, "color:#FF9800");
            },
            _bindPageGuards() {
                const preventPause = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                };
                const resumePlaybackNow = () => this._tryResumePlayback('page-event');
                this._pageGuards = { preventPause, resumePlaybackNow };
                document.addEventListener('mouseleave', preventPause);
                window.addEventListener('mouseleave', preventPause);
                document.addEventListener('mouseout', preventPause);
                window.addEventListener('mouseout', preventPause);
                window.addEventListener('blur', resumePlaybackNow);
                document.addEventListener('visibilitychange', resumePlaybackNow);
            },
            destroy() {
                this._destroyed = true;
                if (this._endedTimer) clearTimeout(this._endedTimer);
                this._endedTimer = null;
                this._isPlaying = false;
                this._clearCheckInterval();
                this._detachVideoEvents();
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                $(document).off('.xuexitongPlayerV3');
                if (this._pageGuards) {
                    const { preventPause, resumePlaybackNow } = this._pageGuards;
                    document.removeEventListener('mouseleave', preventPause);
                    window.removeEventListener('mouseleave', preventPause);
                    document.removeEventListener('mouseout', preventPause);
                    window.removeEventListener('mouseout', preventPause);
                    window.removeEventListener('blur', resumePlaybackNow);
                    document.removeEventListener('visibilitychange', resumePlaybackNow);
                    this._pageGuards = null;
                }
            },
        };

        window.app = app;
        window[APP_KEY] = app;

        try {
            app.run();
            app._bindPageGuards();
        } catch (error) {
            console.error("%c脚本运行失败: ", "color:#F44336;font-weight:bold", error.message);
            console.log("请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。");
        }
    }
})();
