(function () {
  "use strict";
  var version = "0.1.2";
  var lastError = "";
  var timer;
  var state = { initialized: false };

  function render() {
    var status = document.getElementById("startup-status");
    if (status) {
      status.textContent = lastError ? "起動・実行エラー: " + lastError :
        state.initialized ? "起動済み v" + version : "起動処理待ち（起動チェックは読み込み済み）";
      status.className = lastError ? "error" : "";
    }
    if (lastError) {
      var details = document.getElementById("diagnostics");
      if (details) details.value = "Kenshiro v" + version + "\n起動・実行エラー: " + lastError;
    }
  }

  state.markReady = function () {
    state.initialized = true;
    lastError = "";
    if (typeof clearTimeout === "function") clearTimeout(timer);
    render();
    console.log("[Kenshiro] ready v" + version);
  };
  state.reportError = function (error) {
    lastError = error && error.message ? String(error.message) : String(error || "不明なエラー");
    render();
    console.error("[Kenshiro] " + lastError);
  };
  window.__kenshiroBoot = state;
  console.log("[Kenshiro] bootstrap v" + version);
  if (typeof window.addEventListener === "function") {
    window.addEventListener("error", function (event) {
      state.reportError(event.error || event.message || "スクリプトを読み込めません。");
    });
    window.addEventListener("unhandledrejection", function (event) {
      state.reportError(event.reason || "非同期処理が失敗しました。");
    });
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", render);
  }
  if (document.readyState !== "loading") render();
  timer = setTimeout(function () {
    if (!state.initialized && !lastError) {
      state.reportError(new Error("起動処理が完了していません。APP LOGSを確認してください。"));
    }
  }, 2000);
})();
