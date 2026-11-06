/** `?raw` CSS imports are provided by the build plugin in `tsdown.config.ts`. */
declare module '*.css?raw' {
  const text: string
  export default text
}
