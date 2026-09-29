import test from "node:test";
import assert from "node:assert/strict";
import { formatGameAddress } from "../shared/game-address.mjs";

test("player addresses omit the explicit default port for valid hosts", () => {
  for (const [address, expected] of [
    ["localhost:25565", "localhost"],
    ["203.0.113.10:25565", "203.0.113.10"],
    ["Play.Example.test:25565", "Play.Example.test"],
    ["play.example.test.:25565", "play.example.test."],
    ["[2001:db8::1]:25565", "[2001:db8::1]"],
    ["[::ffff:192.0.2.1]:25565", "[::ffff:192.0.2.1]"],
  ])
    assert.equal(formatGameAddress(address), expected, address);
});

test("player addresses preserve custom ports, SRV hostnames and ambiguous input", () => {
  for (const address of [
    "",
    "play.example.test",
    "play.example.test:25566",
    "localhost:25575",
    "203.0.113.10:12345",
    "[2001:db8::1]:25566",
    "[2001:db8::1]",
    "2001:db8::1",
    "2001:db8::25565",
    "2001:db8::1:25565",
    "[not-ipv6]:25565",
    "[2001:db8::25565]:25565",
    "999.0.0.1:25565",
    "https://play.example.test:25565",
    "user@play.example.test:25565",
    "play.example.test/path:25565",
    "play.example.test?port:25565",
    "play.example.test#port:25565",
    "-invalid.example:25565",
    "invalid..example:25565",
    "play.example.test:25565 ",
  ])
    assert.equal(formatGameAddress(address), address, address);
});
