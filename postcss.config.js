import tailwindcss from "@tailwindcss/postcss"

// Tailwind writes `text-*/NN` as color-mix(..., transparent), which lets a
// translucent window show through the glyphs. Mixing toward --oc-text-backdrop
// keeps text opaque; with the variable unset the output is unchanged.
const opaqueTextBackdrop = {
  postcssPlugin: "opaque-text-backdrop",
  OnceExit(root) {
    root.walkDecls("color", (decl) => {
      if (decl.value.startsWith("color-mix(")) {
        decl.value = decl.value.replace(/,\s*transparent\)/g, ", var(--oc-text-backdrop, transparent))")
      }
    })
  },
}

export default {
  plugins: [tailwindcss(), opaqueTextBackdrop],
}