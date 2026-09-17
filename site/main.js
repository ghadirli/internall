"use strict";
/**
 * The hero demo: replays the moment the product is actually about — an agent
 * opening a browser beside the chat and filling a form while you watch.
 *
 * Written as a sequence of typed steps rather than a video so it stays crisp,
 * weighs nothing, and respects prefers-reduced-motion (which jumps to the end
 * state instead of animating).
 */
const SCRIPT = [
    { kind: 'say', who: 'you', text: 'Apply to speak at the Northwind conference for me.' },
    { kind: 'activity', text: 'Opening northwind.dev', done: 'Worked for 6s · 4 steps' },
    { kind: 'browser', url: 'https://northwind.dev/speakers/apply' },
    { kind: 'wait', ms: 300 },
    { kind: 'fill', field: 'name', value: 'Ali Ghadirli' },
    { kind: 'fill', field: 'email', value: 'ali@example.com' },
    { kind: 'fill', field: 'talk', value: 'Designing agents people can watch' },
    { kind: 'say', who: 'agent', text: "That's everything filled in. One thing left." },
    { kind: 'approval' },
];
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Demo {
    constructor(root) {
        this.token = 0;
        this.chat = $('.pane-chat', root);
        this.stage = $('.stage', root);
        this.browser = $('.pane-browser', root);
    }
    get reduced() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    async run() {
        const run = ++this.token;
        this.reset();
        for (const step of SCRIPT) {
            if (run !== this.token)
                return; // a newer replay took over
            await this.perform(step, run);
        }
    }
    reset() {
        this.chat.innerHTML = '';
        this.stage.classList.remove('split');
        this.browser.hidden = true;
        for (const input of document.querySelectorAll('.formcard .input')) {
            input.textContent = '';
            input.classList.remove('filling');
        }
        $('.formcard .submit')?.classList.remove('armed');
    }
    async perform(step, run) {
        switch (step.kind) {
            case 'say': {
                const el = document.createElement('div');
                el.className = `bubble ${step.who === 'you' ? 'out' : 'in'}`;
                this.chat.append(el);
                await this.type(el, step.text, run, step.who === 'you' ? 16 : 22);
                await this.pause(420);
                break;
            }
            case 'activity': {
                const el = document.createElement('div');
                el.className = 'activity live';
                el.innerHTML = '<span class="star">✳︎</span><span></span>';
                el.lastElementChild.textContent = step.text;
                this.chat.append(el);
                await this.pause(1100);
                if (run !== this.token)
                    return;
                el.classList.remove('live');
                el.lastElementChild.textContent = step.done ?? step.text;
                break;
            }
            case 'browser': {
                this.stage.classList.add('split');
                this.browser.hidden = false;
                const url = $('.chip-url', this.browser);
                if (url)
                    url.textContent = step.url;
                await this.pause(500);
                break;
            }
            case 'fill': {
                const input = $(`.input[data-field="${step.field}"]`);
                if (!input)
                    break;
                input.classList.add('filling');
                await this.type(input, step.value, run, 26);
                await this.pause(260);
                input.classList.remove('filling');
                break;
            }
            case 'approval': {
                $('.formcard .submit')?.classList.add('armed');
                const el = document.createElement('div');
                el.className = 'approval';
                el.innerHTML =
                    '<b>🔒 Click “Submit application”?</b>' +
                        '<span>on northwind.dev — this looks like it submits something.</span>' +
                        '<div class="btns"><span class="yes">Allow</span><span>Not now</span></div>';
                this.chat.append(el);
                break;
            }
            case 'wait':
                await this.pause(step.ms);
                break;
        }
    }
    /** Types text in, or drops it in whole when motion is unwelcome. */
    async type(el, text, run, perChar) {
        if (this.reduced) {
            el.textContent = text;
            return;
        }
        el.classList.add('caret');
        for (let i = 1; i <= text.length; i++) {
            if (run !== this.token)
                return;
            el.textContent = text.slice(0, i);
            await sleep(perChar);
        }
        el.classList.remove('caret');
    }
    pause(ms) {
        return this.reduced ? Promise.resolve() : sleep(ms);
    }
}
function startDemo() {
    const root = $('#demo');
    if (!root)
        return;
    const demo = new Demo(root);
    // Only start once it is actually on screen, so the opening line is not
    // already over by the time someone looks at it.
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting)
                continue;
            io.disconnect();
            demo.run();
        }
    }, { threshold: 0.35 });
    io.observe(root);
    $('.replay')?.addEventListener('click', () => demo.run());
}
function revealOnScroll() {
    const items = document.querySelectorAll('.reveal');
    if (!items.length)
        return;
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting)
                continue;
            e.target.classList.add('seen');
            io.unobserve(e.target);
        }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.15 });
    items.forEach((el) => io.observe(el));
}
function currentYear() {
    const el = $('[data-year]');
    if (el)
        el.textContent = String(new Date().getFullYear());
}
startDemo();
revealOnScroll();
currentYear();
