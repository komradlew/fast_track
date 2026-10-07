import request from 'supertest';

export function expectError(
  response: request.Response,
  status: number,
  code: string,
  message?: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.error.code).toBe(code);
  expect(response.body.error.message).toEqual(message ?? expect.any(String));
  expect(response.body.error.requestId).toEqual(expect.any(String));
  expect(response.body.error.requestId).not.toBe('');
  expect(Object.keys(response.body as object)).toEqual(['error']);
}
