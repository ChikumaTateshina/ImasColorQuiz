(function () {
    'use strict';

    var STORAGE_KEY = 'imas-color-quiz/settings/v1';
    var HEX_RE = /^#[0-9a-f]{6}$/i;

    var db = { brands: [], entries: [] };
    var brandById = {};
    var pool = [];        // 現在の出題対象
    var bag = [];         // シャッフル済みの残り（一巡するまで重複しない）
    var currentItem = null;
    var isAnswerShown = false;

    var settings = { brands: null, includeUnits: false };

    var el = {};
    ['statusMessage', 'colorInfo', 'nameLabel', 'cvLabel', 'hexLabel', 'brandLabel',
     'noteLabel', 'answerSwatch', 'hintContainer', 'hint1Button', 'hint2Button',
     'hint3Button', 'settingsButton', 'modalOverlay', 'modalBody', 'settingsOverlay',
     'settingsPanel', 'brandGrid', 'includeUnits', 'selectAllButton', 'selectNoneButton',
     'closeSettingsButton', 'settingsSummary', 'clickHint', 'creditContainer',
     'settingsCredit'].forEach(function (id) {
        el[id] = document.getElementById(id);
    });

    /* ---------- 乱数 ---------- */

    // [0, n) の一様乱数。剰余バイアスを避けるため範囲外を棄却する。
    function randInt(n) {
        if (n <= 1) return 0;
        var crypto = window.crypto || window.msCrypto;
        if (!crypto || !crypto.getRandomValues) {
            return Math.floor(Math.random() * n);
        }
        var limit = Math.floor(4294967296 / n) * n;
        var buf = new Uint32Array(1);
        var v;
        do {
            crypto.getRandomValues(buf);
            v = buf[0];
        } while (v >= limit);
        return v % n;
    }

    function shuffle(list) {
        for (var i = list.length - 1; i > 0; i--) {
            var j = randInt(i + 1);
            var t = list[i];
            list[i] = list[j];
            list[j] = t;
        }
        return list;
    }

    /* ---------- 設定の保存・復元 ---------- */

    function loadSettings() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            var saved = JSON.parse(raw);
            if (saved && Array.isArray(saved.brands)) {
                settings.brands = saved.brands.filter(function (id) {
                    return Object.prototype.hasOwnProperty.call(brandById, id);
                });
            }
            settings.includeUnits = !!(saved && saved.includeUnits);
        } catch (e) {
            /* localStorage が使えない環境（file:// のプライベートモード等）は既定値で動く */
        }
    }

    function saveSettings() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) { /* 保存できなくても動作に影響しない */ }
    }

    /* ---------- 出題プール ---------- */

    function rebuildPool() {
        var allowed = settings.brands;
        pool = db.entries.filter(function (e) {
            if (!settings.includeUnits && e.type === 'unit') return false;
            return allowed.indexOf(e.brand) !== -1;
        });
        bag = [];
    }

    function drawNext() {
        if (pool.length === 0) return null;
        if (bag.length === 0) {
            bag = shuffle(pool.slice());
            // 一巡の切れ目で同じ問題が連続しないようにする
            if (bag.length > 1 && currentItem && bag[bag.length - 1].id === currentItem.id) {
                var swap = randInt(bag.length - 1);
                var t = bag[bag.length - 1];
                bag[bag.length - 1] = bag[swap];
                bag[swap] = t;
            }
        }
        return bag.pop();
    }

    /* ---------- 表示 ---------- */

    function safeColor(value) {
        return HEX_RE.test(value) ? value : '#cccccc';
    }

    // 背景色に載せて読める文字色（白 or 黒）をコントラスト比で選ぶ。
    // ミリオンライブ！(#ffc30b) のような明るいブランド色でも潰れないようにするため。
    function textColorOn(hex) {
        var ch = [1, 3, 5].map(function (i) {
            var c = parseInt(hex.substr(i, 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        var lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        var onWhite = 1.05 / (lum + 0.05);
        var onBlack = (lum + 0.05) / 0.05;
        return onWhite >= onBlack ? '#ffffff' : '#222222';
    }

    function setStatus(text) {
        el.statusMessage.textContent = text || '';
        el.statusMessage.style.display = text ? 'block' : 'none';
    }

    // データ参照元の表記を組み立てる。文言は data/imas_colors.js の credit から取る。
    function renderCredit(target, prefix) {
        var c = db.credit;
        target.textContent = '';
        if (!c || !c.name) return;

        target.appendChild(document.createTextNode(prefix));
        // データ由来の URL をそのまま href にしないよう https:// のみ許可する
        if (c.url && /^https:\/\/[^\s"'<>]+$/.test(c.url)) {
            var a = document.createElement('a');
            a.href = c.url;
            a.textContent = c.name;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            // 画面クリックは「次の問題へ」なので、リンク操作は伝播させない
            a.addEventListener('click', function (e) { e.stopPropagation(); });
            target.appendChild(a);
        } else {
            target.appendChild(document.createTextNode(c.name));
        }
    }

    // ヒント3は CV が無いキャラ（デレのボイス未実装勢やユニット）でも表示する。
    // 「CV情報なし」であること自体が絞り込みのヒントになるため。
    function updateControls() {
        var disabled = !currentItem || isAnswerShown;
        el.hint1Button.disabled = disabled;
        el.hint2Button.disabled = disabled;
        el.hint3Button.disabled = disabled;

        if (!currentItem) {
            el.clickHint.classList.add('is-hidden');
            return;
        }
        el.clickHint.classList.remove('is-hidden');
        el.clickHint.textContent = isAnswerShown
            ? '画面クリック(タップ)で次の問題へ'
            : '画面クリック(タップ)で回答を表示';
    }

    function nextQuestion() {
        closeModal();
        var item = drawNext();
        if (!item) {
            currentItem = null;
            isAnswerShown = false;
            el.colorInfo.classList.remove('is-visible');
            document.body.style.backgroundColor = '#ffffff';
            setStatus('出題できる対象がありません。右上の ⚙ から出題範囲を選び直してください。');
            updateControls();
            return;
        }
        setStatus('');
        currentItem = item;
        isAnswerShown = false;
        document.body.style.backgroundColor = safeColor(item.color);
        el.colorInfo.classList.remove('is-visible');
        updateControls();
    }

    function showAnswer() {
        if (!currentItem) return;
        closeModal();

        var brand = brandById[currentItem.brand];
        var color = safeColor(currentItem.color);

        el.nameLabel.textContent = currentItem.name;
        el.cvLabel.textContent = currentItem.cv ? 'CV. ' + currentItem.cv : '';
        el.hexLabel.textContent = color;
        el.answerSwatch.style.backgroundColor = color;
        var brandColor = brand && HEX_RE.test(brand.color) ? brand.color : '#888888';
        el.brandLabel.textContent = brand ? brand.name : '';
        el.brandLabel.style.backgroundColor = brandColor;
        el.brandLabel.style.color = textColorOn(brandColor);

        var note = [];
        if (currentItem.uncertain) note.push('※参考色');
        if (currentItem.note) note.push(currentItem.note);
        el.noteLabel.textContent = note.join(' / ');

        el.colorInfo.classList.add('is-visible');
        isAnswerShown = true;
        updateControls();
    }

    function openModal(text, swatchColor) {
        el.modalBody.textContent = '';
        if (swatchColor) {
            var chip = document.createElement('span');
            chip.className = 'swatch';
            chip.style.backgroundColor = safeColor(swatchColor);
            el.modalBody.appendChild(chip);
        }
        el.modalBody.appendChild(document.createTextNode(text));
        el.modalOverlay.classList.add('is-visible');
    }

    function closeModal() {
        el.modalOverlay.classList.remove('is-visible');
    }

    /* ---------- 設定パネル ---------- */

    function buildBrandGrid() {
        var counts = {};
        db.entries.forEach(function (e) {
            if (!settings.includeUnits && e.type === 'unit') return;
            counts[e.brand] = (counts[e.brand] || 0) + 1;
        });

        el.brandGrid.textContent = '';
        db.brands.forEach(function (b) {
            var label = document.createElement('label');

            var box = document.createElement('input');
            box.type = 'checkbox';
            box.value = b.id;
            box.checked = settings.brands.indexOf(b.id) !== -1;
            box.addEventListener('change', function () {
                var i = settings.brands.indexOf(b.id);
                if (box.checked && i === -1) settings.brands.push(b.id);
                if (!box.checked && i !== -1) settings.brands.splice(i, 1);
                applySettings();
            });

            var dot = document.createElement('span');
            dot.className = 'brand-dot';
            dot.style.backgroundColor = HEX_RE.test(b.color) ? b.color : '#cccccc';

            var name = document.createElement('span');
            name.className = 'brand-name';
            name.textContent = b.name;

            var count = document.createElement('span');
            count.className = 'brand-count';
            count.textContent = (counts[b.id] || 0);

            label.appendChild(box);
            label.appendChild(dot);
            label.appendChild(name);
            label.appendChild(count);
            el.brandGrid.appendChild(label);
        });
    }

    function updateSummary() {
        el.settingsSummary.textContent =
            '出題対象 ' + pool.length + ' 件 / 全 ' + db.entries.length + ' 件（データ生成日: ' + (db.generatedAt || '-') + '）';
    }

    // 設定変更後は出題プールを組み直し、次の問題から反映する。
    function applySettings() {
        saveSettings();
        rebuildPool();
        buildBrandGrid();
        updateSummary();
        nextQuestion();
    }

    function openSettings() {
        buildBrandGrid();
        updateSummary();
        el.settingsOverlay.classList.add('is-visible');
    }

    function closeSettings() {
        el.settingsOverlay.classList.remove('is-visible');
    }

    /* ---------- 起動 ---------- */

    function init() {
        // データは data/imas_colors.js が window.IMAS_DB に定義する。
        // fetch() で JSON を読む形にすると file:// で開いたときに CORS で失敗するため、
        // どちらの開き方でも動くよう <script src> 経由で受け取っている。
        var raw = window.IMAS_DB;
        if (!raw) {
            setStatus('データを読み込めませんでした。data/imas_colors.js があるか確認し、'
                + '無ければ python tools/build_db.py を実行してください。');
            return;
        }

        var entries = (raw && Array.isArray(raw.entries)) ? raw.entries.filter(function (e) {
            return e && typeof e.name === 'string' && HEX_RE.test(e.color);
        }) : [];

        if (entries.length === 0) {
            setStatus('データが空です。tools/build_db.py を実行してデータを生成してください。');
            return;
        }

        db = {
            brands: raw.brands || [],
            entries: entries,
            generatedAt: raw.generatedAt,
            credit: raw.credit
        };
        db.brands.forEach(function (b) { brandById[b.id] = b; });

        renderCredit(el.creditContainer, 'データ参照元: ');
        renderCredit(el.settingsCredit, 'データ参照元: ');

        settings.brands = db.brands.map(function (b) { return b.id; });
        loadSettings();
        if (!settings.brands || settings.brands.length === 0) {
            settings.brands = db.brands.map(function (b) { return b.id; });
        }
        el.includeUnits.checked = settings.includeUnits;

        rebuildPool();
        nextQuestion();
    }

    /* ---------- イベント ---------- */

    document.body.addEventListener('click', function () {
        if (isAnswerShown || !currentItem) {
            nextQuestion();
        } else {
            showAnswer();
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            closeModal();
            closeSettings();
            return;
        }
        if (e.key !== ' ' && e.key !== 'Enter') return;
        if (e.target && e.target.tagName === 'INPUT') return;
        if (el.settingsOverlay.classList.contains('is-visible')) return;
        e.preventDefault();
        if (el.modalOverlay.classList.contains('is-visible')) {
            closeModal();
        } else if (isAnswerShown || !currentItem) {
            nextQuestion();
        } else {
            showAnswer();
        }
    });

    el.hintContainer.addEventListener('click', function (e) { e.stopPropagation(); });
    el.settingsButton.addEventListener('click', function (e) {
        e.stopPropagation();
        openSettings();
    });

    el.modalOverlay.addEventListener('click', function (e) {
        e.stopPropagation();
        closeModal();
    });

    el.settingsOverlay.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target === el.settingsOverlay) closeSettings();
    });

    el.hint1Button.addEventListener('click', function () {
        if (!currentItem || isAnswerShown) return;
        openModal(safeColor(currentItem.color), currentItem.color);
    });

    el.hint2Button.addEventListener('click', function () {
        if (!currentItem || isAnswerShown) return;
        var brand = brandById[currentItem.brand];
        openModal(brand ? brand.name : '不明', null);
    });

    el.hint3Button.addEventListener('click', function () {
        if (!currentItem || isAnswerShown) return;
        openModal(currentItem.cv ? 'CV. ' + currentItem.cv : 'CV情報なし', null);
    });

    el.includeUnits.addEventListener('change', function () {
        settings.includeUnits = el.includeUnits.checked;
        applySettings();
    });

    el.selectAllButton.addEventListener('click', function () {
        settings.brands = db.brands.map(function (b) { return b.id; });
        applySettings();
    });

    el.selectNoneButton.addEventListener('click', function () {
        settings.brands = [];
        applySettings();
    });

    el.closeSettingsButton.addEventListener('click', closeSettings);

    init();
})();
