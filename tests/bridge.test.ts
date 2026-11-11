import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core/bridge.js';
import type { AssistantAdapter, IncomingMessage, MessagingAdapter } from '../src/core/contracts.js';
import type { RoutingState } from '../src/core/state.js';
import { fakeAssistant, fakeChannel, loadState, opaqueReferences, projectA, projectB, providerNames, withDirectory } from './support/core-fixtures.js';

async function fixture(run: (store: RoutingState, directory: string) => Promise<void>, now?: () => number): Promise<void> {
  await withDirectory(async directory => { await run(await loadState(directory, now), directory); }, 'wabgpt-bridge-');
}
const bridgeOf = (store: RoutingState, assistant: AssistantAdapter, channel: MessagingAdapter, logger: (message: string) => void = () => {}): Bridge => new Bridge(store, assistant, channel, logger, providerNames);
const alice = { id: '11111111111@s.whatsapp.net', name: 'Alice' };
const bob = { id: '22222222222@s.whatsapp.net', name: 'Bob' };
const incoming = (id: string, contact = alice, acknowledge: () => Promise<void> = async () => {}): IncomingMessage => ({ id, contact, text: `Question ${id}`, acknowledge });

test('routes distinct contacts to persistent conversations and suppresses redelivery after restart', async () => {
  await fixture(async (store, directory) => {
    await store.enable(alice); await store.enable(bob);
    const calls: Array<string | null> = [];
    const replies: Array<[string, string]> = [];
    let conversation = 0;
    const assistant = fakeAssistant({ reply: async input => {
      calls.push(input.conversationRef);
      const ref = input.conversationRef || `https://chatgpt.com/c/convo-${++conversation}`;
      await input.onConversation(ref);
      await input.onSubmitted();
      return { conversationRef: ref, text: `Answer ${input.text}` };
    } });
    const channel = fakeChannel({ sendText: async (id, text) => { replies.push([id, text]); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    bridge.receive(incoming('a')); bridge.receive(incoming('b', bob)); bridge.receive(incoming('c')); bridge.receive(incoming('a'));
    await bridge.idle();
    assert.deepEqual(calls, [null, null, 'https://chatgpt.com/c/convo-1']);
    assert.deepEqual(replies, [[alice.id, 'Answer Question a'], [bob.id, 'Answer Question b'], [alice.id, 'Answer Question c']]);
    const restarted = bridgeOf(await loadState(directory), assistant, channel); restarted.arm();
    restarted.receive(incoming('a')); await restarted.idle();
    assert.equal(calls.length, 3);
  });
});

test('uncertain delivery pauses contact and does not replay its pending messages', async () => {
  await fixture(async store => {
    await store.enable(alice);
    let calls = 0;
    const assistant = fakeAssistant({ reply: async input => {
      calls++; await input.onConversation('https://chatgpt.com/c/retained'); await input.onSubmitted(); throw new Error('Response timed out after submission');
    } });
    const channel = fakeChannel({ sendText: async () => { assert.fail('Must not send on failed generation'); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    bridge.receive(incoming('a')); bridge.receive(incoming('b')); await bridge.idle();
    assert.equal(calls, 1);
    assert.equal(store.route(alice.id)?.enabled, false);
    assert.equal(store.route(alice.id)?.conversationRef, 'https://chatgpt.com/c/retained');
    await store.enable(alice); bridge.receive(incoming('a')); await bridge.idle(); assert.equal(calls, 1);
  });
});

test('restart quarantines interrupted delivery and prevents cross-contact conversation reuse', async () => {
  await fixture(async (store, directory) => {
    await store.enable(alice); await store.enable(bob);
    await store.conversation(alice.id, 'https://chatgpt.com/c/unique');
    await assert.rejects(store.conversation(bob.id, 'https://chatgpt.com/c/unique'), /another contact/);
    await store.claim('interrupted', alice.id);
    const restored = await loadState(directory);
    assert.equal(restored.route(alice.id)?.enabled, false);
    assert.match(restored.route(alice.id)?.error || '', /Interrupted/);
    assert.equal(await restored.claim('interrupted', alice.id), false);
  });
});

test('pause during generation prevents the pending reply', async () => {
  await fixture(async store => {
    await store.enable(alice);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const assistant = fakeAssistant({ reply: async input => {
      await input.onConversation('https://chatgpt.com/c/paused');
      await input.onSubmitted();
      entered.resolve();
      await release.promise;
      return { conversationRef: 'https://chatgpt.com/c/paused', text: 'Do not deliver' };
    } });
    const channel = fakeChannel({ sendText: async () => { assert.fail('Must not send after pause'); } });
    const bridge = bridgeOf(store, assistant, channel);
    bridge.arm(); bridge.receive(incoming('pause'));
    await entered.promise;
    bridge.disarm(); release.resolve();
    await bridge.idle();
    assert.equal(store.route(alice.id)?.enabled, false);
    assert.match(store.route(alice.id)?.error || '', /paused before reply/);
  });
});

test('read receipt follows prompt acceptance, acknowledges the original message once, and does not wait for generation', async () => {
  await fixture(async store => {
    await store.enable(alice);
    const entered = Promise.withResolvers<void>();
    const accept = Promise.withResolvers<void>();
    const generate = Promise.withResolvers<void>();
    const seen = Promise.withResolvers<void>();
    let receipts = 0;
    const replies: string[] = [];
    const assistant = fakeAssistant({ reply: async input => {
      entered.resolve(); await accept.promise;
      await input.onConversation('https://chatgpt.com/c/seen');
      await input.onSubmitted();
      await generate.promise;
      return { conversationRef: 'https://chatgpt.com/c/seen', text: 'Answer' };
    } });
    const channel = fakeChannel({ sendText: async (_id, text) => { replies.push(text); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    const message = incoming('seen', alice, async () => { receipts++; seen.resolve(); });
    bridge.receive(message); await entered.promise;
    assert.equal(receipts, 0);
    accept.resolve(); await seen.promise;
    assert.equal(receipts, 1);
    assert.deepEqual(replies, []);
    generate.resolve(); await bridge.idle();
    assert.deepEqual(replies, ['Answer']);
    bridge.receive(message); await bridge.idle();
    assert.equal(receipts, 1);
  });
});

test('rejected assistant submissions leave messages unread', async () => {
  await fixture(async store => {
    await store.enable(alice);
    let receipts = 0;
    const replies: string[] = [];
    const assistant = fakeAssistant({ reply: async () => { throw new Error('Submission rejected'); } });
    const channel = fakeChannel({ sendText: async (_id, text) => { replies.push(text); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    bridge.receive(incoming('rejected', alice, async () => { receipts++; })); await bridge.idle();
    assert.equal(receipts, 0);
    assert.deepEqual(replies, []);
    assert.equal(store.route(alice.id)?.enabled, false);
  });
});

test('a failed read receipt does not resend the prompt or prevent the completed reply', async () => {
  await fixture(async store => {
    await store.enable(alice);
    let submissions = 0;
    let receiptAttempts = 0;
    const replies: string[] = [];
    const logs: string[] = [];
    const assistant = fakeAssistant({ reply: async input => {
      submissions++;
      await input.onConversation('https://chatgpt.com/c/read-failure');
      await input.onSubmitted();
      return { conversationRef: 'https://chatgpt.com/c/read-failure', text: 'Answer' };
    } });
    const channel = fakeChannel({ sendText: async (_id, text) => { replies.push(text); } });
    const bridge = bridgeOf(store, assistant, channel, text => logs.push(text)); bridge.arm();
    bridge.receive(incoming('receipt-failure', alice, async () => { receiptAttempts++; throw new Error('Receipt connection failed'); })); await bridge.idle();
    assert.equal(submissions, 1);
    assert.equal(receiptAttempts, 1);
    assert.deepEqual(replies, ['Answer']);
    assert.equal(store.route(alice.id)?.enabled, true);
    assert.ok(logs.includes('WhatsApp read receipt failed for Alice: Receipt connection failed'));
  });
});

test('a slow read receipt cannot hold up delivery of an already completed assistant reply', { timeout: 5000 }, async () => {
  await fixture(async store => {
    await store.enable(alice);
    const receipt = Promise.withResolvers<void>();
    const sent = Promise.withResolvers<void>();
    let receiptFinished = false;
    const assistant = fakeAssistant({ reply: async input => {
      await input.onConversation('https://chatgpt.com/c/slow-receipt');
      await input.onSubmitted();
      return { conversationRef: 'https://chatgpt.com/c/slow-receipt', text: 'Ready now' };
    } });
    const channel = fakeChannel({ sendText: async (_id, text) => { assert.equal(text, 'Ready now'); assert.equal(receiptFinished, false); sent.resolve(); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    bridge.receive(incoming('slow-receipt', alice, async () => { await receipt.promise; receiptFinished = true; }));
    await sent.promise; receipt.resolve(); await bridge.idle();
    assert.equal(receiptFinished, true);
  });
});

test('log lines and route errors use the configured provider names', async () => {
  await fixture(async store => {
    await store.enable(alice);
    const logs: string[] = [];
    const assistant = fakeAssistant({ reply: async input => { await input.onSubmitted(); throw new Error('boom'); } });
    const bridge = new Bridge(store, assistant, fakeChannel(), text => logs.push(text), { channelName: 'Chat', assistantName: 'Helper' }); bridge.arm();
    bridge.receive(incoming('named')); await bridge.idle();
    assert.ok(logs.some(line => line.startsWith('Helper accepted the message from Alice after ') && line.endsWith('sending Chat read receipt.')));
    assert.equal(logs.at(-1), 'Paused Alice: boom Inspect Chat and Helper before enabling again. No automatic replay.');
  });
});

test('a conversation is reused until its fixed lifetime ends, then the next message starts a fresh one in the project', async () => {
  let clock = 10_000_000;
  await fixture(async (store, directory) => {
    await store.setProject(alice, projectA);
    await store.setConversationTtl(alice, 5);
    await store.enable(alice);
    const calls: Array<{ conversationRef: string | null; projectRef: string | null }> = [];
    let conversation = 0;
    const assistant = fakeAssistant({ reply: async input => {
      calls.push({ conversationRef: input.conversationRef, projectRef: input.projectRef });
      const ref = input.conversationRef || `${projectA}/c/convo-${++conversation}`;
      await input.onConversation(ref);
      await input.onSubmitted();
      return { conversationRef: ref, text: 'Answer' };
    } });
    const bridge = bridgeOf(store, assistant, fakeChannel()); bridge.arm();
    bridge.receive(incoming('a')); await bridge.idle();
    clock += 5 * 60_000 - 1;
    bridge.receive(incoming('b')); await bridge.idle();
    assert.equal(store.route(alice.id)?.conversationStartedAt, 10_000_000);
    clock += 1;
    bridge.receive(incoming('c')); await bridge.idle();
    assert.deepEqual(calls, [
      { conversationRef: null, projectRef: projectA },
      { conversationRef: `${projectA}/c/convo-1`, projectRef: projectA },
      { conversationRef: null, projectRef: projectA },
    ]);
    assert.equal(store.route(alice.id)?.conversationRef, `${projectA}/c/convo-2`);
    assert.equal(store.route(alice.id)?.conversationStartedAt, clock);
    assert.equal(store.route(alice.id)?.enabled, true);
    const restarted = await loadState(directory, () => clock + 10);
    assert.equal(restarted.route(alice.id)?.conversationStartedAt, clock);
  }, () => clock);
});

test('an expired conversation is cleared before submission and not by a timer or a duplicate delivery', async () => {
  let clock = 1_000;
  await fixture(async store => {
    await store.setConversationTtl(alice, 1);
    await store.enable(alice);
    await store.conversation(alice.id, 'https://chatgpt.com/c/old');
    const seen: Array<string | null> = [];
    const stored: Array<string | null> = [];
    const assistant = fakeAssistant({ reply: async input => {
      seen.push(input.conversationRef);
      stored.push(store.route(alice.id)?.conversationRef ?? null);
      await input.onConversation('https://chatgpt.com/c/new');
      await input.onSubmitted();
      return { conversationRef: 'https://chatgpt.com/c/new', text: 'Answer' };
    } });
    const bridge = bridgeOf(store, assistant, fakeChannel()); bridge.arm();
    clock += 10 * 60_000;
    assert.equal(store.route(alice.id)?.conversationRef, 'https://chatgpt.com/c/old');
    bridge.receive(incoming('a')); await bridge.idle();
    assert.deepEqual(seen, [null]);
    assert.deepEqual(stored, [null]);
    assert.equal(store.route(alice.id)?.conversationRef, 'https://chatgpt.com/c/new');
    clock += 10 * 60_000;
    bridge.receive(incoming('a')); await bridge.idle();
    assert.equal(seen.length, 1);
    assert.equal(store.route(alice.id)?.conversationRef, 'https://chatgpt.com/c/new');
  }, () => clock);
});

test('project changes wait for active delivery and queued messages use the latest route', async () => {
  await fixture(async store => {
    await store.enable(alice);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const projects: Array<string | null> = [];
    let first = true;
    const assistant = fakeAssistant({ reply: async input => {
      projects.push(input.projectRef);
      if (first) { first = false; entered.resolve(); await release.promise; }
      const ref = input.projectRef ? `${input.projectRef}/c/${projects.length}` : `https://chatgpt.com/c/${projects.length}`;
      await input.onConversation(ref);
      await input.onSubmitted();
      return { conversationRef: ref, text: 'Answer' };
    } });
    const bridge = bridgeOf(store, assistant, fakeChannel()); bridge.arm();
    bridge.receive(incoming('a')); await entered.promise;
    await assert.rejects(store.setProject(alice, projectA), /delivered/);
    bridge.receive(incoming('b'));
    release.resolve(); await bridge.idle();
    assert.deepEqual(projects, [null, null]);
    await store.setProject(alice, projectA);
    assert.equal(store.route(alice.id)?.conversationRef, null);
    bridge.receive(incoming('c')); await bridge.idle();
    await store.setProject(alice, projectB);
    bridge.receive(incoming('d')); await bridge.idle();
    assert.deepEqual(projects, [null, null, projectA, projectB]);
    assert.equal(store.route(alice.id)?.conversationRef, `${projectB}/c/4`);
  });
});

test('configuring a project for an untouched contact does not let its messages be forwarded', async () => {
  await fixture(async store => {
    await store.setProject(alice, projectA);
    const assistant = fakeAssistant({ reply: async () => { assert.fail('Paused route must not forward'); } });
    const channel = fakeChannel({ sendText: async () => { assert.fail('Paused route must not reply'); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    bridge.receive(incoming('a')); await bridge.idle();
    assert.equal(store.route(alice.id)?.enabled, false);
    assert.equal(store.isRunning(), false);
  });
});

test('opaque non-URL provider references flow through delivery and persistence untouched by core', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory, () => 1, opaqueReferences);
    await store.setProject(alice, 'ws:Notes');
    await store.enable(alice);
    const seen: Array<{ conversationRef: string | null; projectRef: string | null }> = [];
    let thread = 0;
    const replies: string[] = [];
    const assistant = fakeAssistant({
      references: opaqueReferences,
      reply: async input => {
        seen.push({ conversationRef: input.conversationRef, projectRef: input.projectRef });
        const ref = input.conversationRef ?? `${input.projectRef}/thread:t${++thread}`;
        await input.onConversation(ref);
        await input.onSubmitted();
        return { conversationRef: ref, text: 'Answer' };
      },
    });
    const bridge = bridgeOf(store, assistant, fakeChannel({ sendText: async (_id, text) => { replies.push(text); } })); bridge.arm();
    bridge.receive(incoming('a')); bridge.receive(incoming('b')); await bridge.idle();
    assert.deepEqual(seen, [{ conversationRef: null, projectRef: 'ws:notes' }, { conversationRef: 'ws:notes/thread:t1', projectRef: 'ws:notes' }]);
    assert.deepEqual(replies, ['Answer', 'Answer']);
    assert.equal((await loadState(directory, () => 2, opaqueReferences)).route(alice.id)?.conversationRef, 'ws:notes/thread:t1');
  });
});

test('a conversation reference outside the assigned project pauses the contact instead of being delivered', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory, () => 1, opaqueReferences);
    await store.setProject(alice, 'ws:notes');
    await store.enable(alice);
    const assistant = fakeAssistant({
      references: opaqueReferences,
      reply: async input => { await input.onConversation('thread:standalone'); assert.fail('Conversation outside the project must stop the submission'); },
    });
    const bridge = bridgeOf(store, assistant, fakeChannel({ sendText: async () => { assert.fail('Must not reply'); } })); bridge.arm();
    bridge.receive(incoming('a')); await bridge.idle();
    assert.equal(store.route(alice.id)?.enabled, false);
    assert.equal(store.route(alice.id)?.conversationRef, null);
    assert.match(store.route(alice.id)?.error ?? '', /does not belong/);
  });
});

test('colon-containing contact ids and identical raw delivery keys for different contacts are both delivered once', async () => {
  await fixture(async (store, directory) => {
    const short = { id: 'chan', name: 'Short' };
    const long = { id: 'chan:a', name: 'Long' };
    await store.enable(short); await store.enable(long);
    const replies: Array<[string, string]> = [];
    let conversation = 0;
    const assistant = fakeAssistant({ reply: async input => {
      const ref = `https://chatgpt.com/c/colon-${++conversation}`;
      await input.onConversation(ref);
      await input.onSubmitted();
      return { conversationRef: ref, text: `Answer ${input.text}` };
    } });
    const channel = fakeChannel({ sendText: async (id, text) => { replies.push([id, text]); } });
    const bridge = bridgeOf(store, assistant, channel); bridge.arm();
    // Both messages produce the raw journal key "chan:a:1".
    const first: IncomingMessage = { id: 'a:1', contact: short, text: 'from short', acknowledge: async () => {} };
    const second: IncomingMessage = { id: '1', contact: long, text: 'from long', acknowledge: async () => {} };
    bridge.receive(first); bridge.receive(second); bridge.receive(first); bridge.receive(second);
    await bridge.idle();
    assert.deepEqual(replies, [['chan', 'Answer from short'], ['chan:a', 'Answer from long']]);
    const restarted = bridgeOf(await loadState(directory), assistant, channel); restarted.arm();
    restarted.receive(first); restarted.receive(second); await restarted.idle();
    assert.equal(replies.length, 2);
  });
});

test('an alias with a colon-containing id is deduplicated against its canonical contact after the identity merge', async () => {
  await fixture(async store => {
    const alias = { alias: 'chan:lid:7', canonical: 'chan:pn:7' };
    await store.enable({ id: alias.alias, name: 'Carol' });
    let submissions = 0;
    const assistant = fakeAssistant({ reply: async input => {
      submissions++;
      await input.onConversation('https://chatgpt.com/c/alias-colon');
      await input.onSubmitted();
      return { conversationRef: 'https://chatgpt.com/c/alias-colon', text: 'Answer' };
    } });
    const bridge = bridgeOf(store, assistant, fakeChannel()); bridge.arm();
    const viaAlias: IncomingMessage = { id: 'm:1', contact: { id: alias.alias, name: 'Carol' }, text: 'hello', acknowledge: async () => {} };
    bridge.receive(viaAlias); await bridge.idle();
    await store.linkIdentity(alias);
    bridge.receive(viaAlias);
    bridge.receive({ ...viaAlias, contact: { id: alias.canonical, name: 'Carol' } });
    await bridge.idle();
    assert.equal(submissions, 1);
    assert.equal(store.route(alias.alias)?.contactId, alias.canonical);
  });
});
