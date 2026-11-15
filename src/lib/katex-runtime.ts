// Loaded on demand (dynamic import) the first time a reply contains math, so
// KaTeX and its stylesheet never weigh on conversations that have none.
import "katex/dist/katex.min.css";
import katex from "katex";

export default katex;
