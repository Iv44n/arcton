import { nodeAdapter } from '@arcton/adapter-node'
import { Arcton } from '@arcton/core'

const app = Arcton({ adapter: nodeAdapter })

app.get('/', () => {
  return 'Hello, Arcton!'
})

app.listen()
