"use strict";

// A very small stand-in for the browser DOM, just enough to run the frontend
// scripts under Node and inspect what they render. No dependencies.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toLowerCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.ownerDocument = FakeElement.document;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  // Text is kept as plain strings among the children, like text nodes.
  get textContent() {
    return this.children
      .map((child) => (typeof child === "string" ? child : child.textContent))
      .join("");
  }

  set textContent(value) {
    this.children = String(value) === "" ? [] : [String(value)];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(" "); },
      contains: (name) => names().includes(name),
    };
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  fire(type, event = {}) {
    for (const handler of this.listeners[type] || []) {
      handler({ target: this, preventDefault() {}, ...event });
    }
  }

  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
}

class FakeDocument {
  constructor() {
    this.byId = new Map();
    this.body = new FakeElement("body");
    this.hidden = false;
    this.listeners = {};
  }

  getElementById(id) {
    if (!this.byId.has(id)) this.byId.set(id, this.createElement("div"));
    return this.byId.get(id);
  }

  createElement(tag) {
    FakeElement.document = this;
    return new FakeElement(tag);
  }

  createElementNS(namespace, tag) { return this.createElement(tag); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
}

// Every element under root (root included) that passes the test.
function findAll(root, test) {
  const found = [];
  const walk = (node) => {
    if (typeof node === "string") return;
    if (test(node)) found.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return found;
}

const hasClass = (name) => (node) => node.className.split(/\s+/).includes(name);
const hasData = (key, value) => (node) =>
  key in node.dataset && (value === undefined || node.dataset[key] === String(value));
const both = (...tests) => (node) => tests.every((test) => test(node));

function find(root, test) {
  const found = findAll(root, test);
  if (found.length === 0) throw new Error("element not found");
  return found[0];
}

module.exports = { FakeDocument, FakeElement, findAll, find, hasClass, hasData, both };
