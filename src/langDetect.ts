// Extension → language ID mapping
const extMap: Record<string, string> = {
  // Git
  gitconfig: 'git',

  // YAML
  yml: 'yaml',
  yaml: 'yaml',

  // XML / XSL / XQuery
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xsl',
  xslt: 'xsl',
  xq: 'xquery',
  xquery: 'xquery',

  // Markup / Templates
  html: 'html',
  htm: 'html',
  svg: 'svg',
  pug: 'pug',
  jade: 'jade',
  haml: 'haml',
  slim: 'slim',
  njk: 'nunjucks',
  nunjucks: 'nunjucks',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  twig: 'twig',
  ejs: 'html',
  mjml: 'mjml',

  // CSS / Styling
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  styl: 'stylus',
  pcss: 'postcss',

  // JavaScript / TypeScript
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  ets: 'ets',

  // JSON family
  json: 'json',
  jsonl: 'jsonl',
  jsonc: 'jsonc',
  json5: 'json5',
  hjson: 'hjson',

  // Python
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  pyx: 'python',

  // Mojo
  mojo: 'mojo',

  // Ruby
  rb: 'ruby',
  erb: 'ruby',
  gemspec: 'ruby',
  rake: 'ruby',

  // PHP / Hack
  php: 'php',
  hack: 'hack',
  hh: 'hack',

  // Java / JVM
  java: 'java',
  scala: 'scala',
  sc: 'scala',
  groovy: 'groovy',
  gradle: 'groovy',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',

  // C family
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  hh2: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',

  // C#
  cs: 'csharp',
  csx: 'csharp',

  // F#
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',

  // VB
  vb: 'vb',
  vbs: 'vb',

  // Go
  go: 'go',

  // Rust
  rs: 'rust',

  // Swift
  swift: 'swift',

  // Dart
  dart: 'dart',

  // Kotlin
  kt: 'kotlin',
  kts: 'kotlin',

  // Lua / Luau
  lua: 'lua',
  luau: 'luau',

  // Shell
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  bat: 'bat',
  cmd: 'bat',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  awk: 'awk',

  // Ruby-like / Config
  ini: 'ini',
  cfg: 'ini',
  properties: 'properties',
  toml: 'toml',

  // Markdown / Docs
  md: 'markdown',
  mdx: 'markdown',
  markdoc: 'markdoc',
  txt: 'plaintext',
  pdf: 'pdf',
  rst: 'restructuredtext',
  adoc: 'asciidoc',

  // Diff / Patch
  diff: 'diff',
  patch: 'diff',

  // Data formats
  csv: 'csv',
  tsv: 'tsv',

  // SQL
  sql: 'sql',
  kql: 'kql',

  // GraphQL
  graphql: 'graphql',
  gql: 'graphql',

  // Protobuf
  proto: 'proto',

  // Docker (extension-based)
  dockerignore: 'ignore',

  // Terraform / HCL
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'hcl',

  // Nix
  nix: 'nix',

  // Haskell
  hs: 'haskell',
  lhs: 'haskell',
  dhall: 'dhall',
  cabal: 'cabal',

  // Erlang / Elixir
  erl: 'erlang',
  hrl: 'erlang',
  ex: 'elixir',
  exs: 'elixir',

  // Perl
  pl: 'perl',
  pm: 'perl',
  p6: 'perl6',
  pl6: 'perl6',
  pm6: 'perl6',
  raku: 'perl6',

  // Lisp / ML / Functional
  elm: 'elm',
  purs: 'purescript',
  re: 'reason',
  rei: 'reason',
  sml: 'sml',
  sig: 'sml',
  idr: 'idris',

  // Julia
  jl: 'julia',

  // R
  r: 'r',
  R: 'r',

  // Nim
  nim: 'nim',
  nimble: 'nimble',

  // LaTeX / TeX
  tex: 'latex',
  bib: 'bibtex',
  bst: 'bibtex-style',
  cls: 'latex-class',
  sty: 'latex-package',
  dtx: 'doctex',
  ins: 'doctex-installer',

  // Prolog
  pro: 'prolog',

  // CoffeeScript
  coffee: 'coffeescript',

  // LiveScript
  ls: 'livescript',

  // Vue / Svelte / React frameworks
  vue: 'vue',
  svelte: 'svelte',

  // Razor
  razor: 'razor',
  cshtml: 'razor',

  // Haxe
  hx: 'haxe',
  hxml: 'hxml',

  // Puppet
  pp: 'puppet',

  // Solidity
  sol: 'solidity',

  // AutoIt
  au3: 'autoit',

  // YANG
  yang: 'yang',

  // AppleScript
  applescript: 'applescript',
  scpt: 'applescript',

  // Cucumber
  feature: 'cucumber',

  // Riot
  riot: 'riot',

  // Apex / SAS
  trigger: 'apex',
  sas: 'sas',

  // Pawn
  pwn: 'pawn',

  // Cake
  cake: 'cake',

  // API Blueprint
  apib: 'apiblueprint',

  // Robot Framework
  robot: 'robotframework',

  // VimL
  vim: 'viml',

  // Godot
  gd: 'gdscript',
  tres: 'gdresource',
  tscn: 'gdresource',
  gdshader: 'gdshader',

  // Processing
  pde: 'processing',

  // Jinja
  j2: 'jinja',
  jinja: 'jinja',
  jinja2: 'jinja',

  // Log
  log: 'log',

  // Jupyter
  ipynb: 'jupyter',

  // Shaders
  shader: 'shaderlab',
  hlsl: 'hlsl',
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  wgsl: 'wgsl',

  // ReScript
  res: 'rescript',
  resi: 'rescript',

  // Grain
  gr: 'grain',

  // V
  v: 'v',

  // Wolfram
  wl: 'wolfram',
  wls: 'wolfram',

  // Matlab
  mat: 'matlab',

  // Cadence
  cdc: 'cadence',

  // Huff
  huff: 'huff',

  // Blink
  blink: 'blink',

  // CUE
  cue: 'cue',

  // Lean
  lean: 'lean',

  // Slint
  slint: 'slint',

  // Beancount
  beancount: 'beancount',

  // AHK
  ahk: 'ahk2',

  // Gnuplot
  gp: 'gnuplot',
  gnuplot: 'gnuplot',

  // Cap'n Proto
  capnp: 'capnb',

  // CDS (SAP)
  cds: 'cds',

  // Lolcode
  lol: 'lolcode',

  // PGN (chess)
  pgn: 'pgn',

  // Gemini
  gmi: 'gemini',

  // Twee3
  twee: 'twee3',

  // Pip requirements (extension-based)
  pip: 'pip-requirements',

  // SSH
  sshconfig: 'ssh_config',

  // Ballerina
  bal: 'ballerina',

  // Angular template
  'component.html': 'ng-template',

  // Spring Boot
  'application.properties': 'spring-boot-properties',

  // Systemd
  service: 'systemd-unit-file',
  socket: 'systemd-unit-file',
  timer: 'systemd-unit-file',
  target: 'systemd-unit-file',
  mount: 'systemd-unit-file',
  path: 'systemd-unit-file',

  // Tree
  tree: 'tree',
};

// Filename → language ID mapping (exact match)
const nameMap: Record<string, string> = {
  // Git
  '.gitconfig': 'git',
  '.gitmodules': 'git',
  '.gitattributes': 'git',
  COMMIT_EDITMSG: 'git-commit',
  MERGE_MSG: 'git-commit',
  'git-rebase-todo': 'git-rebase',

  // Ignore files
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.npmignore': 'ignore',
  '.eslintignore': 'ignore',
  '.prettierignore': 'ignore',
  '.stylelintignore': 'ignore',
  '.hgignore': 'ignore',
  '.vscodeignore': 'ignore',

  // Makefile
  Makefile: 'makefile',
  makefile: 'makefile',
  GNUmakefile: 'makefile',
  Justfile: 'makefile',
  justfile: 'makefile',

  // Docker
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
  'docker-compose.yml': 'dockercompose',
  'docker-compose.yaml': 'dockercompose',
  'compose.yml': 'dockercompose',
  'compose.yaml': 'dockercompose',
  'docker-bake.hcl': 'dockerbake',
  'docker-bake.json': 'dockerbake',

  // Editor config
  '.editorconfig': 'editorconfig',

  // Pip requirements
  'requirements.txt': 'pip-requirements',
  'constraints.txt': 'pip-requirements',

  // Hosts
  hosts: 'hosts',

  // Nginx
  'nginx.conf': 'nginx',

  // Ansible
  'ansible.cfg': 'ansible',

  // Spring Boot
  'application.yml': 'spring-boot-properties-yaml',
  'application.yaml': 'spring-boot-properties-yaml',
  'application.properties': 'spring-boot-properties',
  'bootstrap.yml': 'spring-boot-properties-yaml',
  'bootstrap.yaml': 'spring-boot-properties-yaml',
  'bootstrap.properties': 'spring-boot-properties',
};

// Filename prefix patterns → language ID
const prefixMap: [string, string][] = [
  ['Dockerfile.', 'dockerfile'],
  ['Dockerfile-', 'dockerfile'],
  ['docker-compose.', 'dockercompose'],
  ['compose.', 'dockercompose'],
];

export function detectLang(name: string): string {
  // 1. Exact filename match
  const byName = nameMap[name];
  if (byName) return byName;

  // 2. Filename prefix match
  for (const [prefix, lang] of prefixMap) {
    if (name.startsWith(prefix)) return lang;
  }

  // 3. Extension match (try full compound ext first, then base ext)
  const dotIndex = name.indexOf('.');
  if (dotIndex >= 0) {
    const fullExt = name.slice(dotIndex + 1);
    // Try compound extensions (e.g. "test.ts" won't match, but "component.html" might)
    if (fullExt in extMap) return extMap[fullExt];

    // Try base extension
    const lastDot = name.lastIndexOf('.');
    if (lastDot !== dotIndex) {
      const baseExt = name.slice(lastDot + 1);
      if (baseExt in extMap) return extMap[baseExt];
    }
  }

  return '';
}
