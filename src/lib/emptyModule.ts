// Stub for jsPDF's optional dependencies (html2canvas, dompurify, canvg).
// They are only reachable through jsPDF's .html() API, which this app never
// calls — the analytics report rasterises its own SVG and draws text directly.
// Without this alias they add roughly 240 KB gzipped to the analytics chunk.
export default {}
