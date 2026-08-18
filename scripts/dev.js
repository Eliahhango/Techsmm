import { spawn } from 'node:child_process'

const processes = [
  spawn(process.execPath, ['backend/backend/server.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
]

function stop() {
  processes.forEach((child) => child.kill())
}

process.on('SIGINT', () => {
  stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  stop()
  process.exit(0)
})

processes.forEach((child) => {
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) process.exitCode = code || 1
  })
})
