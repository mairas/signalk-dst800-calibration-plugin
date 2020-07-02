var stream = require("stream"),
    util = require("util");

const Int64LE = require('int64-buffer').Int64LE
const Uint64LE = require('int64-buffer').Uint64LE

var Concentrate2 = module.exports = function Concentrate2(options) {
  if (!(this instanceof Concentrate2)) { return new Concentrate2(options); }

  stream.Readable.call(this, options);

  this.jobs = [];
};
util.inherits(Concentrate2, stream.Readable);

Concentrate2.prototype._read = function _read(n) {};

Concentrate2.prototype.copy = function copy() {
  var copy = new Concentrate2();
  copy.jobs = this.jobs.slice(0);
  return copy;
};

Concentrate2.prototype.reset = function reset() {
  this.jobs.splice(0);

  return this;
};

Concentrate2.prototype.result = function result() {
  // optimisation for if there's only one job and it's a buffer - we don't need
  // to compile anything, we can just shove the buffer right on through. keep on
  // truckin'.
  if (this.jobs.length === 1 && this.jobs[0].type === "buffer") {
    return this.jobs[0].data;
  }

  var buffer = new Buffer(this.jobs.reduce(function(i, v) { return i + v.length; }, 0));

  var offset = 0;
  this.jobs.forEach(function(job, index) {
    var method = ["write", job.type].join("_");

    if (job.fields) {
      job.data = 255;
      job.fields.forEach(function(field) {
        job.data <<= field.bits;
        job.data |= field.value;
        job.data &= 255;
      })
    }
    
    if (typeof this[method] === "function") {
      try {
        offset += this[method](job, buffer, offset);
      } catch ( err ) {
        console.log(`unable to write job at index ${index} offset ${offset}`)
        throw err
      }
    }
  }.bind(this));

  return buffer;
};

Concentrate2.prototype.flush = function flush(no_reset) {
  this.push(this.result());
  this.reset();

  return this;
};

Concentrate2.prototype.end = function end() {
  this.push(null);

  return this;
};

Concentrate2.prototype.write_number = function write_number(job, buffer, offset) {
  buffer[job.method](job.data, offset);
  return job.length;
};

Concentrate2.prototype.write_buffer = function write_buffer(job, buffer, offset) {
  job.data.copy(buffer, offset);
  return job.data.length;
};

Concentrate2.prototype.buffer = function buffer(data) {
  this.jobs.push({type: "buffer", data: data, length: data.length});
  return this;
};

Concentrate2.prototype.string = function string(data, encoding) {
  return this.buffer(new Buffer(data, encoding));
};


Concentrate2.prototype.uint64 = function uint64(data) {
  /*
   const b = new Buffer(8)
   const MAX_UINT32 = 0xFFFFFFFF
   const big = ~~(data / MAX_UINT32)
   const low = (data % MAX_UINT32) - big
   b.writeUInt32BE(big, 0)
   b.writeUInt32BE(low, 4)
   return this.buffer(b)
  */
  return this.buffer(new Uint64LE(data).toBuffer())
};

Concentrate2.prototype.int64 = function int64(data) {
  return this.buffer(new Int64LE(data).toBuffer())
};


[8, 16, 32].forEach(function(b) {
  ["", "u"].forEach(function(s) {
    ["", "le", "be"].forEach(function(e) {
      // derive endiannes postfix supported by node Buffer api
      // for all the numbers, except 8 bit integer, endiannes is mandatory
      var endiannes = e || "le";
      // for 8 bit integers - no endiannes postfix
      if(b === 8){
          endiannes = "";
      }
      
      var type = [s, "int", b, e].join(""),
          method = ["write", s.toUpperCase(), "Int", b, endiannes.toUpperCase()].join(""),
          length = b / 8;

      Concentrate2.prototype[type] = function(data) {
        this.jobs.push({
          type: "number",
          method: method,
          length: length,
          data: data,
        });

        return this;
      };
    });
  });
});

[["float", 4], ["double", 8]].forEach(function(t) {
  ["le", "be"].forEach(function(e) {
    var type = [t[0], e].join(""),
        method = ["write", t[0].replace(/^(.)/, function(e) { return e.toUpperCase(); }), e.toUpperCase()].join(""),
        length = t[1];

    Concentrate2.prototype[type] = function(data) {
      this.jobs.push({
        type: "number",
        method: method,
        length: length,
        data: data,
      });

      return this;
    };
  });
});


Concentrate2.prototype.tinyInt = function(value, bits) {
  var tinyJob = makeLastJobTiny(this.jobs);
  tinyJob.fields.unshift({
    value: value,
    bits: bits
  });
  tinyJob.bits += bits
  return this
}

function makeLastJobTiny(jobs) {
  if (jobs.length === 0 || !jobs[jobs.length -1].fields) {
    jobs.push({
      type: "number",
      method: "writeUInt8",
      length: 1,
      fields: [],
      bits: 0
    });
  }
  return jobs[jobs.length -1];
}
