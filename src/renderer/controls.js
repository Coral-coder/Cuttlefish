'use strict';
// Generic UI controls for SignalRGB-style parameters (effect <meta> properties
// and plugin ControllableParameters share the same shape).
(function () {
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  function hueToHex(h) {
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function control(param, value, onChange) {
    const v = value === undefined || value === null ? param.default : value;
    const label = el('label', {}, el('span', {}, param.label || param.property));
    const out = el('span', {});
    label.append(out);
    const wrap = el('div', { class: 'ctl', title: param.tooltip || '' }, label);
    const live = debounce(onChange, 30);
    switch (param.type) {
      case 'number':
      case 'hue': {
        const min = Number(param.min ?? 0);
        const max = Number(param.max ?? (param.type === 'hue' ? 360 : 100));
        const step = Number(param.step || 1);
        const input = el('input', { type: 'range', min, max, step, value: Number(v), class: param.type === 'hue' ? 'hue-range' : '' });
        const show = () => {
          out.textContent = input.value;
          if (param.type === 'hue') out.style.color = hueToHex(Number(input.value));
        };
        input.addEventListener('input', () => { show(); live(Number(input.value)); });
        show();
        wrap.append(el('div', { class: 'row' }, input));
        break;
      }
      case 'boolean': {
        const input = el('input', { type: 'checkbox' });
        input.checked = truthy(v);
        input.addEventListener('change', () => onChange(param.__plugin ? input.checked : input.checked ? 1 : 0));
        const sw = el('label', { class: 'switch' }, input, el('span'));
        label.replaceChildren(el('span', {}, param.label || param.property), sw);
        break;
      }
      case 'color': {
        const input = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff' });
        const txt = el('input', { type: 'text', value: input.value, style: 'width:90px' });
        input.addEventListener('input', () => { txt.value = input.value; live(input.value); });
        txt.addEventListener('change', () => {
          if (/^#[0-9a-f]{6}$/i.test(txt.value)) { input.value = txt.value; onChange(txt.value); }
        });
        wrap.append(el('div', { class: 'row' }, input, txt));
        break;
      }
      case 'combobox':
      case 'list': {
        const sel = el('select', {}, (param.values || []).map((o) => el('option', { value: o, selected: String(o) === String(v) }, o)));
        sel.addEventListener('change', () => onChange(sel.value));
        wrap.append(sel);
        break;
      }
      default: {
        const input = el('input', { type: 'text', value: v ?? '' });
        input.addEventListener('input', () => live(input.value));
        wrap.append(input);
      }
    }
    return wrap;
  }

  window.CFControls = { el, control, debounce, truthy };
})();
