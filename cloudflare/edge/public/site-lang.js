(function () {
  "use strict";
  var KEY = "veyl.lang";

  document.addEventListener("click", function (e) {
    var node = e.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute("data-set-lang")) {
        try { localStorage.setItem(KEY, node.getAttribute("data-set-lang")); } catch (err) {}
        return;
      }
      node = node.parentNode;
    }
  });

  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  var p = location.pathname, isEn = p === "/en" || p.indexOf("/en/") === 0;
  var alt;
  if (isEn) {
    alt = p.replace(/^\/en(\/|$)/, "$1");
    if (!alt) alt = "/";
    if (alt.charAt(0) !== "/") alt = "/" + alt;
  } else {
    alt = "/en" + (p === "/" ? "/" : p);
  }
  var link = document.createElement("link");
  link.rel = "prefetch";
  link.href = alt;
  document.head.appendChild(link);
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e2) {}
  var want = stored || ((navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en");
  if (want === (isEn ? "en" : "zh")) return;
  location.replace(alt + location.search + location.hash);
})();
