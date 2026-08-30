/**
 * 万象的浏览器半边：品牌与主题，长在 DSH 客户端的正规插槽里。
 *
 * DSH 的前端本身就是一套 cordis——30 个 dsh-client-ui-* 插件经
 * /plugins/<pkg>/client.js 按需下发，品牌位（sidebar.brand.mark /
 * sidebar.brand.name / conversation.hero.brand.mark）是官方白牌机制：
 * bundle 里禁掉 ui-brand-official，这里注册万象自己的占位组件。
 *
 * 主题走 ctx.theme.overrideTokens——token 级的插槽遮蔽：底座主题不动，
 * 叠一层万象的暖纸配色，卸载即还原。light/dark 两个值都必须给，
 * 这是 API 强制的（validateOverrides 会抛教学式错误）。
 *
 * 格式是手写的 classic script（与 dsh-client-ui-brand-official 同构，
 * 那是整个 monorepo 里最小的官方样例，1.9KB）。用纯 JS——
 * dsh-client-ui-slots / primitives 的类型没随包发布，TS 反而过不了检查。
 */
window.__ModuleLoader__.load({
  id: "@centaur/wanxiang",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const jsx = require("react/jsx-runtime");

    /** 半人马 logo。资源走万象自己的 /static 路由，同源。 */
    function WanxiangMark({ size, className }) {
      return jsx.jsx("img", {
        src: "/static/logo-256.png",
        alt: "半人马AI-万象",
        className,
        style: { width: size, height: size, objectFit: "contain", display: "block" },
      });
    }

    function WanxiangName() {
      return jsx.jsx("span", { children: "半人马AI-万象" });
    }

    /** 万象的暖纸配色（与 public/static/app.css 的 :root 同源）。 */
    const BRAND_TOKENS = {
      "--dsw-alias-brand-primary": { light: "#D97757", dark: "#E08A6D" },
      "--dsw-alias-bg-base": { light: "#FAF9F5", dark: "#1B1A17" },
    };

    const inject = ["slots", "theme"];

    function apply(ctx) {
      ctx.effect(
        () => ctx.theme.overrideTokens("@centaur/wanxiang", BRAND_TOKENS),
        "wanxiang: brand tokens",
      );

      // 声明感知注入：等三个品牌插槽的声明方（sidebar / conversation）就位，
      // 再一个事务把三个占位一起注册——失败回滚，反序拆除。
      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", () =>
          ctx.slots.inject("conversation.hero.brand.mark", function* () {
            yield ctx.slots.register({ name: "sidebar.brand.mark" }, WanxiangMark);
            yield ctx.slots.register({ name: "sidebar.brand.name" }, WanxiangName);
            yield ctx.slots.register({ name: "conversation.hero.brand.mark" }, WanxiangMark);
          }),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
