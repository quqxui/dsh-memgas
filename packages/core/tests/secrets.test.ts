import { describe, expect, test } from 'vitest'
import { redactSecrets } from '../src/secrets.ts'

describe('redactSecrets', () => {
  test('redacts an assigned api key but keeps the surrounding sentence', () => {
    const { text, redactions } = redactSecrets('部署脚本里写死了 api_key = "sk-abcd1234abcd1234abcd1234" 需要改掉')
    expect(text).toContain('部署脚本里写死了')
    expect(text).toContain('需要改掉')
    expect(text).not.toContain('sk-abcd1234abcd1234abcd1234')
    expect(redactions).toBe(1)
  })

  test('redacts a bare vendor-style token anywhere in the text', () => {
    const { text } = redactSecrets('token 是 ghp_0123456789abcdef0123456789abcdef0123')
    expect(text).not.toContain('ghp_0123456789abcdef0123456789abcdef0123')
  })

  test('redacts an entire private key block', () => {
    const input = '证书内容：\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcdef\n-----END RSA PRIVATE KEY-----\n后面还有正文'
    const { text } = redactSecrets(input)
    expect(text).not.toContain('MIIEowIBAAKCAQEA1234')
    expect(text).toContain('后面还有正文')
  })

  test('leaves ordinary code and prose untouched', () => {
    const input = '把 packages/core/src/store.ts 的 timeoutMs = 300 改成 500，用户说密码错了也要记一下'
    const { text, redactions } = redactSecrets(input)
    expect(text).toBe(input)
    expect(redactions).toBe(0)
  })
})
