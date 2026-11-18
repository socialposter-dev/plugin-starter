// Extism interface declaration file passed to `extism-js -i src/plugin.d.ts`.

declare module "main" {
  export function describe(): I32;
  export function validate_auth(): I32;
  export function publish(): I32;
  export function delete_post(): I32;
}
