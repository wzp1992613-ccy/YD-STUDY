

const pro = new Promise((resolve, reject) => {
  const innerpro = new Promise((r, reject) => {
    setTimeout(() => {
      r(1);
    });
    console.log(2);
    r(3);
  });
  resolve(4);
  innerpro.then((res) => console.log(res));
  console.log("yideng");
});
pro.then((res) => console.log(res));
console.log("end");
