import { expect, test } from 'bun:test'
import { pathParamNames, toOpenAPIPath } from './path'

test('a static path is unchanged', () => {
  expect(toOpenAPIPath('/users')).toBe('/users')
  expect(toOpenAPIPath('/')).toBe('/')
})

test('dynamic segments become path templates', () => {
  expect(toOpenAPIPath('/users/:id')).toBe('/users/{id}')
  expect(toOpenAPIPath('/users/:userId/posts/:postId')).toBe(
    '/users/{userId}/posts/{postId}'
  )
})

test('a wildcard path has no OpenAPI equivalent', () => {
  expect(toOpenAPIPath('/files/*rest')).toBeUndefined()
  expect(toOpenAPIPath('/*rest')).toBeUndefined()
})

test('pathParamNames lists dynamic segments in order', () => {
  expect(pathParamNames('/users/:userId/posts/:postId')).toEqual([
    'userId',
    'postId'
  ])
  expect(pathParamNames('/users')).toEqual([])
})
