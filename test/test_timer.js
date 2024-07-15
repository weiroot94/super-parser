import timer from '../src/util/timer.js';

const t = new timer(() => {
  console.log("I am timer!!!");
})

//t.tickEvery(1);

t.tickAfter(5);