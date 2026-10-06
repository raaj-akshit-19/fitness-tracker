"use strict";

// Shared formatting and element helpers. Values are only formatted here,
// never calculated.

const EMPTY = "-";
const SVG_NS = "http://www.w3.org/2000/svg";

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "2-digit", month: "short", timeZone: "UTC",
});
const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

function parseDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDay(iso) {
  return dayFormat.format(parseDay(iso));
}

function formatNumber(value) {
  return typeof value === "number" ? numberFormat.format(value) : EMPTY;
}

function formatPercent(value) {
  return typeof value === "number" ? `${numberFormat.format(value)}%` : EMPTY;
}

function formatWithUnit(value, unit) {
  return typeof value === "number" ? `${numberFormat.format(value)} ${unit}` : EMPTY;
}

function formatSigned(value, suffix) {
  if (typeof value !== "number") return EMPTY;
  const sign = value > 0 ? "+" : "";
  return `${sign}${numberFormat.format(value)}${suffix}`;
}

function formatDays(count) {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

// A figure with its unit, as two parts: the number, then the unit in a span of
// its own so that it can be set smaller. The text reads exactly as it did.
function unitParts(text) {
  const match = /^(\S*\d)(%| \D+)$/.exec(text);
  return match ? [match[1], make("span", { class: "unit", text: match[2] })] : [text];
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props.data || {})) node.dataset[key] = value;
  for (const [key, value] of Object.entries(props.attrs || {})) node.setAttribute(key, value);
  if (props.text !== undefined) node.textContent = props.text;
}

// make("td", {class, text, data: {...}, attrs: {...}}, ...children)
function make(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  applyProps(node, props);
  node.append(...children);
  return node;
}

function makeSvg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (props.class) node.setAttribute("class", props.class);
  applyProps(node, props);
  node.append(...children);
  return node;
}
