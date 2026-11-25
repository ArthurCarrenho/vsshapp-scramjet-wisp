// As threads do libuv, onde o `dns.lookup` do Node roda.
//
// O `dns.lookup` chama o `getaddrinfo` da glibc numa thread do pool do libuv, e o libuv deixa as
// consultas de nome com no máximo metade do pool, para o disco nunca ficar sem thread. Com o pool
// padrão de quatro, são duas consultas ao mesmo tempo. Com o link até o resolvedor perdendo
// pacotes, cada consulta sem resposta segura a thread por 5 s a cada tentativa da glibc, e o nome
// seguinte espera na fila: atrás de quatro consultas presas, `localhost` levou 20 s para resolver
// com quatro threads e 0 ms com trinta e duas (medido com um resolvedor mudo, timeout:5 attempts:2).
// Trinta e duas threads custam a pilha reservada de cada uma e deixam dezesseis consultas correrem
// juntas, que é o que uma página com muitos hosts pede de uma vez.
//
// O libuv lê a variável na primeira tarefa que manda ao pool, e por isso este módulo é o primeiro
// import do `server.js`. Quem sobe o processo com `UV_THREADPOOL_SIZE` próprio fica com o dele.
process.env.UV_THREADPOOL_SIZE ??= '32';
