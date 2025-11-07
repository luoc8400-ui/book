(() => {
  const els = {
    fileInput: document.getElementById('fileInput'),
    urlInput: document.getElementById('urlInput'),
    loadUrlBtn: document.getElementById('loadUrlBtn'),
    voiceSelect: document.getElementById('voiceSelect'),
    rate: document.getElementById('rate'),
    pitch: document.getElementById('pitch'),
    volume: document.getElementById('volume'),
    rateValue: document.getElementById('rateValue'),
    pitchValue: document.getElementById('pitchValue'),
    volumeValue: document.getElementById('volumeValue'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    resumeBtn: document.getElementById('resumeBtn'),
    stopBtn: document.getElementById('stopBtn'),
    textContainer: document.getElementById('textContainer'),
    chapterSelect: document.getElementById('chapterSelect'),
    status: document.getElementById('status'),
    resumePrompt: document.getElementById('resumePrompt'),
    resumeStartBtn: document.getElementById('resumeStartBtn'),
    restartStartBtn: document.getElementById('restartStartBtn'),
    fileList: document.getElementById('fileList'),
    refreshListBtn: document.getElementById('refreshListBtn'),
    loadAllBtn: document.getElementById('loadAllBtn')
  };

  const state = {
    fileName: null,
    text: '',
    sentences: [],
    currentIndex: 0,
    chapters: [],
    voices: [],
    voice: null,
    rate: 1.0, pitch: 1.0, volume: 1.0,
    playing: false,
    speakingLock: false,
    // 新增：同源与本地列表初始化，避免未定义
    sameOriginFiles: [],
    localFiles: [],
    chapterRanges: [],
    currentChapterIndex: 0,
    autoChapterAdvance: true,
    autoPlayOnLoad: true,
    autoLoadAllDone: false
  };

  const progressKey = () => state.fileName ? `reader-progress:${state.fileName}` : null;

  function setStatus(msg) {
    if (els.status) {
      els.status.textContent = `状态：${msg}`;
    } else {
      console.log(`状态：${msg}`);
    }
  }
  function enableControls(loaded) {
    els.playBtn.disabled = !loaded;
    els.pauseBtn.disabled = !loaded;
    els.resumeBtn.disabled = !loaded;
    els.stopBtn.disabled = !loaded;
    els.chapterSelect.disabled = !loaded;
  }
  // 新增：统一的安全事件绑定与滑块绑定
  function on(el, event, handler) {
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(event, handler);
    }
  }
  function bindSliderSafe(el, labelEl, key) {
    if (!el || !labelEl) return;
    el.addEventListener('input', () => {
      state[key] = Number(el.value);
      labelEl.textContent = state[key].toFixed(1);
      if (speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        updateUIPlaying(false);
      }
    });
  }

  // 宽容式 JSON 解析：清除 BOM，替换中文引号
  async function fetchJsonFlexible(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const txt = await res.text();
    const sanitized = txt
      .replace(/^\uFEFF/, '')           // 去 BOM
      .replace(/[“”]/g, '"')            // 替换中文双引号
      .replace(/[‘’]/g, "'");           // 替换中文单引号
    try {
      return JSON.parse(sanitized);
    } catch (e) {
      console.warn('JSON 解析失败，返回空列表', e);
      return [];
    }
  }
  function populateVoices(preferZh = true) {
    const all = window.speechSynthesis.getVoices() || [];
    const zhVoices = all.filter(v => /^zh/i.test(v.lang));
    state.voices = zhVoices.length && preferZh ? zhVoices : all;
    els.voiceSelect.innerHTML = '';
    state.voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${v.name} (${v.lang})${v.default ? ' - 默认' : ''}`;
      els.voiceSelect.appendChild(opt);
    });
    const idxZh = state.voices.findIndex(v => /^zh/i.test(v.lang));
    const idx = idxZh >= 0 ? idxZh : 0;
    els.voiceSelect.value = String(Math.max(idx, 0));
    state.voice = state.voices[Math.max(idx, 0)] || null;
  }
  // 语音列表初始化：增加轮询等待，兼容浏览器初始为空
  function registerVoicesReady() {
    const waitForVoices = (timeoutMs = 3000) => new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const list = window.speechSynthesis.getVoices() || [];
        if (list.length || Date.now() - start >= timeoutMs) resolve(list);
        else setTimeout(tick, 200);
      };
      tick();
    });
    waitForVoices().then(() => populateVoices(true));
    window.speechSynthesis.onvoiceschanged = () => populateVoices(true);
  }

  // 智能解码：优先无替换符的结果，兼容 gb18030/gbk/big5/utf-16
  // 升级：智能解码，兼容 gb18030/gbk/big5/utf-16，并按评分选择最优
  function decodeBuffer(buf) {
    const u8 = new Uint8Array(buf);
    const bomEncoding = (() => {
      if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return 'utf-8';
      if (u8[0] === 0xFF && u8[1] === 0xFE) return 'utf-16le';
      if (u8[0] === 0xFE && u8[1] === 0xFF) return 'utf-16be';
      return null;
    })();
    const tryDecode = (label) => { try { return new TextDecoder(label).decode(buf); } catch { return null; } };
    const score = (s) => {
      if (!s) return -Infinity;
      const bad = (s.match(/\uFFFD/g) || []).length;
      const han = (s.match(/[\u4E00-\u9FFF]/g) || []).length;
      const punct = (s.match(/[。！？；：、，—…“”‘’]/g) || []).length;
      return han * 2 + punct - bad * 5;
    };
    if (bomEncoding) {
      const byBom = tryDecode(bomEncoding);
      if (byBom) return byBom;
    }
    const candidates = [
      tryDecode('utf-8'),
      tryDecode('gb18030'),
      tryDecode('gbk'),
      tryDecode('big5'),
      tryDecode('utf-16le'),
      tryDecode('utf-16be'),
      new TextDecoder().decode(buf)
    ];
    const utf8 = candidates[0];
    if (utf8 && !utf8.includes('\uFFFD')) return utf8;
    let best = candidates[0], bestScore = score(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      const s = candidates[i], sc = score(s);
      if (sc > bestScore) { best = s; bestScore = sc; }
    }
    return best || new TextDecoder().decode(buf);
  }

  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    return decodeBuffer(buf);
  }

  function splitSentencesWithPos(text) {
    const normalized = text.replace(/\r/g, '');
    const re = /([。！？!?；;：:]+[”’"]?|…{2,}|\n{2,})/g;
    const out = [];
    let last = 0, m;
    while ((m = re.exec(normalized)) !== null) {
      const end = m.index + m[0].length;
      const slice = normalized.slice(last, end).trim();
      if (slice) out.push({ text: slice, start: last, end });
      last = end;
    }
    const rest = normalized.slice(last).trim();
    if (rest) out.push({ text: rest, start: last, end: normalized.length });
    return out;
  }
  function extractChapters(text) {
    const lines = text.split(/\r?\n/);
    const starts = [];
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      starts[i] = pos;
      pos += lines[i].length + 1;
    }
    const chapters = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^第[一二三四五六七八九十百千0-9]+章/.test(line) ||
          /^第[一二三四五六七八九十百千0-9]+节/.test(line) ||
          /^(楔子|序章|引子)/.test(line)) {
        chapters.push({ title: line, charOffset: starts[i] });
      }
    }
    if (chapters.length === 0) chapters.push({ title: '全文开始', charOffset: 0 });
    return chapters;
  }
  function mapCharOffsetToSentenceIndex(charOffset, sentences) {
    let lo = 0, hi = sentences.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start >= charOffset) { ans = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    return ans;
  }

  function renderText(sentences, currentIdx) {
    els.textContainer.innerHTML = '';
    const frag = document.createDocumentFragment();
    sentences.forEach((s, i) => {
      const span = document.createElement('span');
      span.className = 'sentence' + (i === currentIdx ? ' current' : (i < currentIdx ? ' dim' : ''));
      span.textContent = s.text;
      span.dataset.idx = String(i);
      span.addEventListener('click', () => {
        state.currentIndex = i;
        highlightCurrent();
      });
      frag.appendChild(span);
    });
    els.textContainer.appendChild(frag);
    highlightCurrent();
  }
  function highlightCurrent() {
    const nodes = els.textContainer.querySelectorAll('.sentence');
    nodes.forEach(n => n.classList.remove('current'));
    const current = els.textContainer.querySelector(`.sentence[data-idx="${state.currentIndex}"]`);
    if (current) current.classList.add('current'), current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function chunkSentence(text, maxLen = 220) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, Math.min(i + maxLen, text.length)));
      i += maxLen;
    }
    return chunks;
  }

  function saveProgress() {
    const key = progressKey();
    if (!key) return;
    const data = {
      index: state.currentIndex,
      rate: state.rate, pitch: state.pitch, volume: state.volume,
      voiceName: state.voice?.name || null,
      time: Date.now()
    };
    localStorage.setItem(key, JSON.stringify(data));
  }
  function readProgress() {
    const key = progressKey();
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function updateUIPlaying(isPlaying) {
    state.playing = isPlaying;
    els.playBtn.disabled = !state.sentences.length || isPlaying;
    els.pauseBtn.disabled = !isPlaying;
    els.resumeBtn.disabled = !state.sentences.length || isPlaying;
    els.stopBtn.disabled = !state.sentences.length || (!isPlaying && !speechSynthesis.speaking);
    setStatus(isPlaying ? `朗读中（第 ${state.currentIndex + 1} 句）` : '就绪');
  }

  function computeChapterRanges(chapters, sentences) {
    const ranges = [];
    for (let i = 0; i < chapters.length; i++) {
      const startIdx = mapCharOffsetToSentenceIndex(chapters[i].charOffset, sentences);
      const nextStart = chapters[i + 1]?.charOffset ?? Infinity;
      const endIdx = Math.max(0, mapCharOffsetToSentenceIndex(nextStart, sentences) - 1);
      ranges.push({ start: startIdx, end: endIdx });
    }
    return ranges;
  }
  function currentChapterBySentenceIndex(si) {
    const ranges = state.chapterRanges;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (si >= r.start && si <= r.end) return i;
    }
    return Math.max(0, ranges.length - 1);
  }
  function setCurrentChapter(chIdx) {
    if (chIdx < 0 || chIdx >= state.chapters.length) return;
    state.currentChapterIndex = chIdx;
    els.chapterSelect.value = String(chIdx);
  }

  function loadText(text, fileName) {
    state.fileName = fileName || '未命名.txt';
    state.text = text;
    state.sentences = splitSentencesWithPos(text);
    state.chapters = extractChapters(text);

    els.chapterSelect.innerHTML = '';
    state.chapters.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = c.title;
      els.chapterSelect.appendChild(opt);
    });
    els.chapterSelect.value = '0';

    const prog = readProgress();
    if (prog && typeof prog.index === 'number') {
      els.resumePrompt.hidden = false;
      els.resumeStartBtn.onclick = () => {
        els.resumePrompt.hidden = true;
        state.rate = prog.rate ?? state.rate;
        state.pitch = prog.pitch ?? state.pitch;
        state.volume = prog.volume ?? state.volume;
        els.rate.value = String(state.rate);
        els.pitch.value = String(state.pitch);
        els.volume.value = String(state.volume);
        els.rateValue.textContent = state.rate.toFixed(1);
        els.pitchValue.textContent = state.pitch.toFixed(1);
        els.volumeValue.textContent = state.volume.toFixed(1);
        const voiceIdx = state.voices.findIndex(v => v.name === prog.voiceName);
        if (voiceIdx >= 0) { els.voiceSelect.value = String(voiceIdx); state.voice = state.voices[voiceIdx]; }
        state.currentIndex = prog.index;
        renderText(state.sentences, state.currentIndex);
        enableControls(true);
        setCurrentChapter(currentChapterBySentenceIndex(state.currentIndex));
        setStatus(`已加载：${state.fileName}，恢复到第 ${state.currentIndex + 1} 句`);
        if (state.autoPlayOnLoad) { populateVoices(true); speakFrom(state.currentIndex); }
      };
      els.restartStartBtn.onclick = () => {
        els.resumePrompt.hidden = true;
        state.currentIndex = 0;
        renderText(state.sentences, state.currentIndex);
        enableControls(true);
        setCurrentChapter(currentChapterBySentenceIndex(state.currentIndex));
        setStatus(`已加载：${state.fileName}`);
        if (state.autoPlayOnLoad) { populateVoices(true); speakFrom(state.currentIndex); }
      };
    } else {
      els.resumePrompt.hidden = true;
      state.currentIndex = 0;
      renderText(state.sentences, state.currentIndex);
      enableControls(true);
      setCurrentChapter(currentChapterBySentenceIndex(state.currentIndex));
      setStatus(`已加载：${state.fileName}`);
      if (state.autoPlayOnLoad) { populateVoices(true); speakFrom(state.currentIndex); }
    }
  }

  function speakFrom(index) {
    if (!state.voices.length) populateVoices(true);
    updateUIPlaying(true);
    state.speakingLock = false;
    state.currentIndex = index;
    highlightCurrent();
    scheduleNext();
  }
  function scheduleNext() {
    if (state.speakingLock) return;
    if (state.currentIndex >= state.sentences.length) {
      updateUIPlaying(false); setStatus('朗读完成'); return;
    }
    const sentence = state.sentences[state.currentIndex].text;
    const chunks = chunkSentence(sentence);
    state.speakingLock = true;
    let chunkIdx = 0;
    const speakChunk = () => {
      if (chunkIdx >= chunks.length) {
        state.currentIndex++; saveProgress(); state.speakingLock = false; highlightCurrent();
        if (state.autoChapterAdvance) {
          const newCh = currentChapterBySentenceIndex(state.currentIndex);
          if (newCh !== state.currentChapterIndex) {
            setCurrentChapter(newCh);
            setStatus(`自动跳至下一章：${state.chapters[newCh]?.title || ''}`);
          }
        }
        scheduleNext(); return;
      }
      const u = new SpeechSynthesisUtterance(chunks[chunkIdx]);
      u.voice = state.voice || null; u.rate = state.rate; u.pitch = state.pitch; u.volume = state.volume;
      u.onend = () => { chunkIdx++; speakChunk(); };
      u.onerror = () => { chunkIdx++; speakChunk(); };
      window.speechSynthesis.speak(u);
    };
    speakChunk();
  }

  // 事件绑定统一改为安全绑定
  registerVoicesReady();

  on(els.fileInput, 'change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('读取文件中...');
    const text = await decodeFile(file);
    loadText(text, file.name);
  });

  on(els.voiceSelect, 'change', () => {
    const idx = Number(els.voiceSelect.value);
    state.voice = state.voices[idx] || null;
    window.speechSynthesis.cancel();
    updateUIPlaying(false);
  });

  bindSliderSafe(els.rate, els.rateValue, 'rate');
  bindSliderSafe(els.pitch, els.pitchValue, 'pitch');
  bindSliderSafe(els.volume, els.volumeValue, 'volume');

  on(els.playBtn, 'click', () => { populateVoices(true); speakFrom(state.currentIndex); });
  on(els.pauseBtn, 'click', () => { if (speechSynthesis.speaking) { speechSynthesis.pause(); updateUIPlaying(false); setStatus('已暂停'); } });
  on(els.resumeBtn, 'click', () => { speechSynthesis.resume(); updateUIPlaying(true); setStatus('继续朗读'); });
  on(els.stopBtn, 'click', () => { speechSynthesis.cancel(); updateUIPlaying(false); setStatus('已停止'); });

  on(els.chapterSelect, 'change', () => {
    const idx = Number(els.chapterSelect.value);
    const targetChar = state.chapters[idx]?.charOffset ?? 0;
    state.currentIndex = mapCharOffsetToSentenceIndex(targetChar, state.sentences);
    setCurrentChapter(idx);
    highlightCurrent();
    setStatus(`已跳转到：${state.chapters[idx]?.title || '全文开始'}`);
  });

  on(els.loadUrlBtn, 'click', () => {
    const url = (els.urlInput?.value || '').trim();
    if (!url) return;
    loadFromUrl(url);
  });

  on(els.refreshListBtn, 'click', () => loadManifest());
  on(els.loadAllBtn, 'click', () => loadAllSameOrigin());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // 读取站点清单并渲染列表（改为仅以 files.json 为准）
  async function loadManifest() {
    const sortFn = (a, b) => {
      const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
      const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
      return (na - nb) || a.localeCompare(b);
    };
  
    let files = [];
    try {
      files = await fetchJsonFlexible('./files.json'); // 使用宽容式解析
    } catch (e) {
      console.warn('无法加载 files.json', e);
    }
  
    // 仅以 files.json 为准，去除兜底探测，避免额外网络开销
    state.sameOriginFiles = (files || []).filter(n => /\.txt$/i.test(n)).sort(sortFn);
    renderFileList();
    setStatus(`已加载站点列表，共 ${state.sameOriginFiles.length} 个`);
  
    // 自动流式加载全部（可按需关闭）
    if (!state.autoLoadAllDone && state.sameOriginFiles.length) {
      state.autoLoadAllDone = true;
      await loadAllSameOriginStreaming();
    }
  }

  // 新增：统一的安全事件绑定与滑块绑定工具函数
  function on(el, event, handler) {
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(event, handler);
    }
  }
  function bindSliderSafe(el, labelEl, key) {
    if (!el || !labelEl) return;
    el.addEventListener('input', () => {
      state[key] = Number(el.value);
      labelEl.textContent = state[key].toFixed(1);
      if (speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        updateUIPlaying(false);
      }
    });
  }

  // 新增：分批加载全部同源 TXT（降低一次性内存与网络压力）
  async function loadAllSameOrigin() {
    if (!state.sameOriginFiles.length) {
      setStatus('站点列表为空，无法加载全部');
      return;
    }
    try {
      const names = state.sameOriginFiles.slice();
      const BATCH_SIZE = 2;         // 可调：每批加载的文件数量
      const mergedParts = [];
      setStatus('加载全部中...');
      for (let i = 0; i < names.length; i += BATCH_SIZE) {
        const batch = names.slice(i, i + BATCH_SIZE);
        for (const name of batch) {
          const url = `./${encodeURIComponent(name)}`;
          const res = await fetch(url, { cache: 'no-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
          const buf = await res.arrayBuffer();
          mergedParts.push(`【${name}】\n` + decodeBuffer(buf));
        }
        setStatus(`已加载 ${Math.min(i + BATCH_SIZE, names.length)}/${names.length}`);
        // 让出事件循环，避免长任务卡顿
        await Promise.resolve();
      }
      const merged = mergedParts.join('\n\n');
      loadText(merged, '合集.txt');
      setStatus(`已加载合集（${names.length} 个文件）`);
    } catch (e) {
      console.error(e);
      setStatus('加载全部失败');
    }
  }

  function renderFileList() {
    if (!els.fileList) return;
    els.fileList.innerHTML = '';
    const items = state.sameOriginFiles.map(name => ({
      name,
      path: `./${encodeURIComponent(name)}`
    }));

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.textContent = '暂无可用 TXT。请在仓库根添加 files.json 或上传 TXT。';
      els.fileList.appendChild(li);
      return;
    }

    items.forEach(it => {
      const li = document.createElement('li');
      li.className = 'list-item';

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = it.name;

      const srcEl = document.createElement('span');
      srcEl.className = 'src';
      srcEl.textContent = '站点';

      const actions = document.createElement('div');
      actions.className = 'actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-secondary';
      openBtn.textContent = '加载';
      openBtn.onclick = () => loadFromUrl(it.path);

      actions.appendChild(openBtn);
      li.appendChild(nameEl);
      li.appendChild(srcEl);
      li.appendChild(actions);
      els.fileList.appendChild(li);
    });
  }

  // 安全绑定：将“加载全部”切换为流式加载
  on(els.loadAllBtn, 'click', () => loadAllSameOriginStreaming());

  // 页面初始化时加载清单（只保留一次调用）
  loadManifest();
  
  })(); // 正确调用 IIFE，避免格式/语法问题造成未执行
  els.chapterSelect.addEventListener('change', () => {
    const idx = Number(els.chapterSelect.value);
    const targetChar = state.chapters[idx]?.charOffset ?? 0;
    state.currentIndex = mapCharOffsetToSentenceIndex(targetChar, state.sentences);
    highlightCurrent();
    setStatus(`已跳转到：${state.chapters[idx]?.title || '全文开始'}`);
  });

