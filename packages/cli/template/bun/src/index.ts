import { Arcton } from '@arcton/core'

const app = Arcton()

app.get('/', () => {
  return 'Hello, Arcton!'
})

app.listen()
