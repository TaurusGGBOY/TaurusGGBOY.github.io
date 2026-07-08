import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";

export default defineConfig({
  site: "https://taurusggboy.github.io",
  output: "static",
  integrations: [mdx()],
});
