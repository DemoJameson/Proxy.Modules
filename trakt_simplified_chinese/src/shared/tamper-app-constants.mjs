// 篡改应用授权使用的 Trakt 官方 App client id：脚本改写与 bulk 出站请求共用同一份常量
const TRAKT_TAMPER_CLIENT_ID = "fa21865a71b1bbf9464522c876864aa6e863df53d1f3e3fc7398394ead549787";

// 这些 client 的授权不占用 Trakt 的授权数量限制，篡改它们反而会白白占用篡改应用的授权额度，因此一律放行
const TRAKT_TAMPER_EXEMPT_CLIENT_IDS = Object.freeze([
    // Infuse
    "c4fef84f7aafc1cf8aba918eb355753c3b642acab0b7f01b3a40e464a74ee39b",
    // Showly
    "89afc4578f40f9b12a9f3b6a0a3127aec304500940777ab7220c0e8a8d8d3907",
    // Rippple
    "a1588f6d5d669d9a4b6411f07dc0bb1fa46f92b345cb91f209dd9cf48ae587f1",
    // EplayerX
    "e682872df368a8a715a31f0d0d4dcda7cb7cbb3dc0a16a3d5976fb7e958fc0c0",
]);

export { TRAKT_TAMPER_CLIENT_ID, TRAKT_TAMPER_EXEMPT_CLIENT_IDS };
