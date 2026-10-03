/**
 * Passwords that are refused because they are on every guess list. Lower case only, at least 12 characters (shorter
 * ones are refused by the length rule anyway). A password is compared in lower case, so `PASSWORD1234` is refused too.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password1234", "password12345", "password123456", "password1234567", "password12345678", "passwordpassword",
  "password!1234", "password@1234", "password#1234", "password2020", "password2021", "password2022",
  "password2023", "password2024", "password2025", "password2026",
  "123456789012", "1234567890123", "12345678901234", "123456789123", "111111111111", "000000000000",
  "123123123123", "121212121212", "112233445566", "654321654321", "987654321098", "012345678901",
  "123456123456", "abcdefghijkl", "abcdefg12345", "abcd12345678", "abcd1234abcd",
  "qwertyuiop12", "qwertyuiop123", "qwertyuiopas", "qwerty123456", "qwerty1234567", "qwertyqwerty",
  "asdfghjkl123", "asdfghjklzxcv", "zxcvbnm12345", "zxcvbnmasdfg", "1qaz2wsx3edc", "1q2w3e4r5t6y",
  "1q2w3e4r5t6y7u", "1qazxsw23edc", "qazwsxedc123", "qazwsxedcrfv",
  "iloveyou1234", "iloveyou12345", "letmein12345", "letmein123456", "letmeinletmein", "welcome12345",
  "welcome123456", "welcome1234567", "welcomewelcome", "administrator", "administrator1", "administrator123",
  "adminadmin123", "admin1234567", "admin12345678", "admin123456789",
  "changeme1234", "changeme12345", "changemechange", "changeme123456", "monkey123456", "dragon123456",
  "football1234", "baseball1234", "superman1234", "sunshine1234", "princess1234", "master123456",
  "shadow123456", "passw0rd1234", "passw0rd12345", "p@ssw0rd1234", "p@ssword1234", "pa55word1234",
  "secret123456", "secretsecret", "default12345", "defaultpassword", "abc123abc123", "test12345678",
  "testtesttest", "guest1234567", "hello1234567", "helloworld123", "internet1234", "computer1234",
]);
