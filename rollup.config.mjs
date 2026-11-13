const banner = '/*! visitojs | MIT */'

export default [
  {
    input: 'build/esm/index.js',
    output: [
      { file: 'dist/visito.js', format: 'iife', name: 'Visito', banner },
      { file: 'dist/visito.esm.js', format: 'es', banner },
    ],
  },
  // the deferred build: the same session, started by the page; one global name, so the page's calls are the core's plus start()
  {
    input: 'build/esm/defer.js',
    output: [
      { file: 'dist/visito.defer.js', format: 'iife', name: 'Visito', banner },
      { file: 'dist/visito.defer.esm.js', format: 'es', banner },
    ],
  },
  { input: 'build/esm/lab.js', output: { file: 'dist/visito.lab.js', format: 'iife', name: 'Visito', banner } },
  { input: 'build/esm/match.js', output: { file: 'dist/match.js', format: 'es', banner } },
  // the deep entry stands alone: its own global, so loading the core after it cannot overwrite it
  {
    input: 'build/esm/deep.js',
    output: [
      { file: 'dist/deep.js', format: 'iife', name: 'VisitoDeep', banner },
      { file: 'dist/deep.esm.js', format: 'es', banner },
    ],
  },
]
