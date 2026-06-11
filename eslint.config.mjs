import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: [".next/**", "node_modules/**", "supabase/.temp/**"],
  },
  {
    // Pre-existing upstream violations (upstream never gated lint — `next lint`
    // was removed in Next 16). Downgraded to warnings to keep the diff surgical;
    // new code should not add to them.
    rules: {
      "react/no-unescaped-entities": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
