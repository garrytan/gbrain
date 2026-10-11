import { expect, test } from 'bun:test';
import { mcpServiceOrigin } from '../admin/src/lib/mcp-service-origin';

test('桌面 MCP 地址使用当前服务端口，不使用文件页面地址或写死端口', () => {
  expect(mcpServiceOrigin('file://', { port: 4137 })).toBe('http://127.0.0.1:4137');
  expect(mcpServiceOrigin('file://', null)).toBe('');
  expect(mcpServiceOrigin('file://', { port: 0 })).toBe('');
  expect(mcpServiceOrigin('null', { port: 65536 })).toBe('');
  expect(mcpServiceOrigin('http://localhost:5173', { port: 4137 })).toBe('http://127.0.0.1:4137');
});

test('浏览器保留实际 HTTP 服务地址', () => {
  expect(mcpServiceOrigin('https://brain.example')).toBe('https://brain.example');
  expect(mcpServiceOrigin('http://localhost:4321')).toBe('http://localhost:4321');
});
