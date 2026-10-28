(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/qrcode/lib/can-promise.js
  var require_can_promise = __commonJS({
    "node_modules/qrcode/lib/can-promise.js"(exports, module) {
      module.exports = function() {
        return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
      };
    }
  });

  // node_modules/qrcode/lib/core/utils.js
  var require_utils = __commonJS({
    "node_modules/qrcode/lib/core/utils.js"(exports) {
      var toSJISFunction;
      var CODEWORDS_COUNT = [
        0,
        // Not used
        26,
        44,
        70,
        100,
        134,
        172,
        196,
        242,
        292,
        346,
        404,
        466,
        532,
        581,
        655,
        733,
        815,
        901,
        991,
        1085,
        1156,
        1258,
        1364,
        1474,
        1588,
        1706,
        1828,
        1921,
        2051,
        2185,
        2323,
        2465,
        2611,
        2761,
        2876,
        3034,
        3196,
        3362,
        3532,
        3706
      ];
      exports.getSymbolSize = function getSymbolSize(version) {
        if (!version) throw new Error('"version" cannot be null or undefined');
        if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
        return version * 4 + 17;
      };
      exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
        return CODEWORDS_COUNT[version];
      };
      exports.getBCHDigit = function(data) {
        let digit = 0;
        while (data !== 0) {
          digit++;
          data >>>= 1;
        }
        return digit;
      };
      exports.setToSJISFunction = function setToSJISFunction(f) {
        if (typeof f !== "function") {
          throw new Error('"toSJISFunc" is not a valid function.');
        }
        toSJISFunction = f;
      };
      exports.isKanjiModeEnabled = function() {
        return typeof toSJISFunction !== "undefined";
      };
      exports.toSJIS = function toSJIS(kanji) {
        return toSJISFunction(kanji);
      };
    }
  });

  // node_modules/qrcode/lib/core/error-correction-level.js
  var require_error_correction_level = __commonJS({
    "node_modules/qrcode/lib/core/error-correction-level.js"(exports) {
      exports.L = { bit: 1 };
      exports.M = { bit: 0 };
      exports.Q = { bit: 3 };
      exports.H = { bit: 2 };
      function fromString(string) {
        if (typeof string !== "string") {
          throw new Error("Param is not a string");
        }
        const lcStr = string.toLowerCase();
        switch (lcStr) {
          case "l":
          case "low":
            return exports.L;
          case "m":
          case "medium":
            return exports.M;
          case "q":
          case "quartile":
            return exports.Q;
          case "h":
          case "high":
            return exports.H;
          default:
            throw new Error("Unknown EC Level: " + string);
        }
      }
      exports.isValid = function isValid(level) {
        return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
      };
      exports.from = function from(value, defaultValue) {
        if (exports.isValid(value)) {
          return value;
        }
        try {
          return fromString(value);
        } catch (e) {
          return defaultValue;
        }
      };
    }
  });

  // node_modules/qrcode/lib/core/bit-buffer.js
  var require_bit_buffer = __commonJS({
    "node_modules/qrcode/lib/core/bit-buffer.js"(exports, module) {
      function BitBuffer() {
        this.buffer = [];
        this.length = 0;
      }
      BitBuffer.prototype = {
        get: function(index) {
          const bufIndex = Math.floor(index / 8);
          return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
        },
        put: function(num, length) {
          for (let i = 0; i < length; i++) {
            this.putBit((num >>> length - i - 1 & 1) === 1);
          }
        },
        getLengthInBits: function() {
          return this.length;
        },
        putBit: function(bit) {
          const bufIndex = Math.floor(this.length / 8);
          if (this.buffer.length <= bufIndex) {
            this.buffer.push(0);
          }
          if (bit) {
            this.buffer[bufIndex] |= 128 >>> this.length % 8;
          }
          this.length++;
        }
      };
      module.exports = BitBuffer;
    }
  });

  // node_modules/qrcode/lib/core/bit-matrix.js
  var require_bit_matrix = __commonJS({
    "node_modules/qrcode/lib/core/bit-matrix.js"(exports, module) {
      function BitMatrix(size) {
        if (!size || size < 1) {
          throw new Error("BitMatrix size must be defined and greater than 0");
        }
        this.size = size;
        this.data = new Uint8Array(size * size);
        this.reservedBit = new Uint8Array(size * size);
      }
      BitMatrix.prototype.set = function(row, col, value, reserved) {
        const index = row * this.size + col;
        this.data[index] = value;
        if (reserved) this.reservedBit[index] = true;
      };
      BitMatrix.prototype.get = function(row, col) {
        return this.data[row * this.size + col];
      };
      BitMatrix.prototype.xor = function(row, col, value) {
        this.data[row * this.size + col] ^= value;
      };
      BitMatrix.prototype.isReserved = function(row, col) {
        return this.reservedBit[row * this.size + col];
      };
      module.exports = BitMatrix;
    }
  });

  // node_modules/qrcode/lib/core/alignment-pattern.js
  var require_alignment_pattern = __commonJS({
    "node_modules/qrcode/lib/core/alignment-pattern.js"(exports) {
      var getSymbolSize = require_utils().getSymbolSize;
      exports.getRowColCoords = function getRowColCoords(version) {
        if (version === 1) return [];
        const posCount = Math.floor(version / 7) + 2;
        const size = getSymbolSize(version);
        const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
        const positions = [size - 7];
        for (let i = 1; i < posCount - 1; i++) {
          positions[i] = positions[i - 1] - intervals;
        }
        positions.push(6);
        return positions.reverse();
      };
      exports.getPositions = function getPositions(version) {
        const coords = [];
        const pos = exports.getRowColCoords(version);
        const posLength = pos.length;
        for (let i = 0; i < posLength; i++) {
          for (let j = 0; j < posLength; j++) {
            if (i === 0 && j === 0 || // top-left
            i === 0 && j === posLength - 1 || // bottom-left
            i === posLength - 1 && j === 0) {
              continue;
            }
            coords.push([pos[i], pos[j]]);
          }
        }
        return coords;
      };
    }
  });

  // node_modules/qrcode/lib/core/finder-pattern.js
  var require_finder_pattern = __commonJS({
    "node_modules/qrcode/lib/core/finder-pattern.js"(exports) {
      var getSymbolSize = require_utils().getSymbolSize;
      var FINDER_PATTERN_SIZE = 7;
      exports.getPositions = function getPositions(version) {
        const size = getSymbolSize(version);
        return [
          // top-left
          [0, 0],
          // top-right
          [size - FINDER_PATTERN_SIZE, 0],
          // bottom-left
          [0, size - FINDER_PATTERN_SIZE]
        ];
      };
    }
  });

  // node_modules/qrcode/lib/core/mask-pattern.js
  var require_mask_pattern = __commonJS({
    "node_modules/qrcode/lib/core/mask-pattern.js"(exports) {
      exports.Patterns = {
        PATTERN000: 0,
        PATTERN001: 1,
        PATTERN010: 2,
        PATTERN011: 3,
        PATTERN100: 4,
        PATTERN101: 5,
        PATTERN110: 6,
        PATTERN111: 7
      };
      var PenaltyScores = {
        N1: 3,
        N2: 3,
        N3: 40,
        N4: 10
      };
      exports.isValid = function isValid(mask) {
        return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
      };
      exports.from = function from(value) {
        return exports.isValid(value) ? parseInt(value, 10) : void 0;
      };
      exports.getPenaltyN1 = function getPenaltyN1(data) {
        const size = data.size;
        let points = 0;
        let sameCountCol = 0;
        let sameCountRow = 0;
        let lastCol = null;
        let lastRow = null;
        for (let row = 0; row < size; row++) {
          sameCountCol = sameCountRow = 0;
          lastCol = lastRow = null;
          for (let col = 0; col < size; col++) {
            let module2 = data.get(row, col);
            if (module2 === lastCol) {
              sameCountCol++;
            } else {
              if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
              lastCol = module2;
              sameCountCol = 1;
            }
            module2 = data.get(col, row);
            if (module2 === lastRow) {
              sameCountRow++;
            } else {
              if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
              lastRow = module2;
              sameCountRow = 1;
            }
          }
          if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
          if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
        }
        return points;
      };
      exports.getPenaltyN2 = function getPenaltyN2(data) {
        const size = data.size;
        let points = 0;
        for (let row = 0; row < size - 1; row++) {
          for (let col = 0; col < size - 1; col++) {
            const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
            if (last === 4 || last === 0) points++;
          }
        }
        return points * PenaltyScores.N2;
      };
      exports.getPenaltyN3 = function getPenaltyN3(data) {
        const size = data.size;
        let points = 0;
        let bitsCol = 0;
        let bitsRow = 0;
        for (let row = 0; row < size; row++) {
          bitsCol = bitsRow = 0;
          for (let col = 0; col < size; col++) {
            bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
            if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
            bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
            if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
          }
        }
        return points * PenaltyScores.N3;
      };
      exports.getPenaltyN4 = function getPenaltyN4(data) {
        let darkCount = 0;
        const modulesCount = data.data.length;
        for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
        const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
        return k * PenaltyScores.N4;
      };
      function getMaskAt(maskPattern, i, j) {
        switch (maskPattern) {
          case exports.Patterns.PATTERN000:
            return (i + j) % 2 === 0;
          case exports.Patterns.PATTERN001:
            return i % 2 === 0;
          case exports.Patterns.PATTERN010:
            return j % 3 === 0;
          case exports.Patterns.PATTERN011:
            return (i + j) % 3 === 0;
          case exports.Patterns.PATTERN100:
            return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
          case exports.Patterns.PATTERN101:
            return i * j % 2 + i * j % 3 === 0;
          case exports.Patterns.PATTERN110:
            return (i * j % 2 + i * j % 3) % 2 === 0;
          case exports.Patterns.PATTERN111:
            return (i * j % 3 + (i + j) % 2) % 2 === 0;
          default:
            throw new Error("bad maskPattern:" + maskPattern);
        }
      }
      exports.applyMask = function applyMask(pattern, data) {
        const size = data.size;
        for (let col = 0; col < size; col++) {
          for (let row = 0; row < size; row++) {
            if (data.isReserved(row, col)) continue;
            data.xor(row, col, getMaskAt(pattern, row, col));
          }
        }
      };
      exports.getBestMask = function getBestMask(data, setupFormatFunc) {
        const numPatterns = Object.keys(exports.Patterns).length;
        let bestPattern = 0;
        let lowerPenalty = Infinity;
        for (let p = 0; p < numPatterns; p++) {
          setupFormatFunc(p);
          exports.applyMask(p, data);
          const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
          exports.applyMask(p, data);
          if (penalty < lowerPenalty) {
            lowerPenalty = penalty;
            bestPattern = p;
          }
        }
        return bestPattern;
      };
    }
  });

  // node_modules/qrcode/lib/core/error-correction-code.js
  var require_error_correction_code = __commonJS({
    "node_modules/qrcode/lib/core/error-correction-code.js"(exports) {
      var ECLevel = require_error_correction_level();
      var EC_BLOCKS_TABLE = [
        // L  M  Q  H
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        2,
        2,
        1,
        2,
        2,
        4,
        1,
        2,
        4,
        4,
        2,
        4,
        4,
        4,
        2,
        4,
        6,
        5,
        2,
        4,
        6,
        6,
        2,
        5,
        8,
        8,
        4,
        5,
        8,
        8,
        4,
        5,
        8,
        11,
        4,
        8,
        10,
        11,
        4,
        9,
        12,
        16,
        4,
        9,
        16,
        16,
        6,
        10,
        12,
        18,
        6,
        10,
        17,
        16,
        6,
        11,
        16,
        19,
        6,
        13,
        18,
        21,
        7,
        14,
        21,
        25,
        8,
        16,
        20,
        25,
        8,
        17,
        23,
        25,
        9,
        17,
        23,
        34,
        9,
        18,
        25,
        30,
        10,
        20,
        27,
        32,
        12,
        21,
        29,
        35,
        12,
        23,
        34,
        37,
        12,
        25,
        34,
        40,
        13,
        26,
        35,
        42,
        14,
        28,
        38,
        45,
        15,
        29,
        40,
        48,
        16,
        31,
        43,
        51,
        17,
        33,
        45,
        54,
        18,
        35,
        48,
        57,
        19,
        37,
        51,
        60,
        19,
        38,
        53,
        63,
        20,
        40,
        56,
        66,
        21,
        43,
        59,
        70,
        22,
        45,
        62,
        74,
        24,
        47,
        65,
        77,
        25,
        49,
        68,
        81
      ];
      var EC_CODEWORDS_TABLE = [
        // L  M  Q  H
        7,
        10,
        13,
        17,
        10,
        16,
        22,
        28,
        15,
        26,
        36,
        44,
        20,
        36,
        52,
        64,
        26,
        48,
        72,
        88,
        36,
        64,
        96,
        112,
        40,
        72,
        108,
        130,
        48,
        88,
        132,
        156,
        60,
        110,
        160,
        192,
        72,
        130,
        192,
        224,
        80,
        150,
        224,
        264,
        96,
        176,
        260,
        308,
        104,
        198,
        288,
        352,
        120,
        216,
        320,
        384,
        132,
        240,
        360,
        432,
        144,
        280,
        408,
        480,
        168,
        308,
        448,
        532,
        180,
        338,
        504,
        588,
        196,
        364,
        546,
        650,
        224,
        416,
        600,
        700,
        224,
        442,
        644,
        750,
        252,
        476,
        690,
        816,
        270,
        504,
        750,
        900,
        300,
        560,
        810,
        960,
        312,
        588,
        870,
        1050,
        336,
        644,
        952,
        1110,
        360,
        700,
        1020,
        1200,
        390,
        728,
        1050,
        1260,
        420,
        784,
        1140,
        1350,
        450,
        812,
        1200,
        1440,
        480,
        868,
        1290,
        1530,
        510,
        924,
        1350,
        1620,
        540,
        980,
        1440,
        1710,
        570,
        1036,
        1530,
        1800,
        570,
        1064,
        1590,
        1890,
        600,
        1120,
        1680,
        1980,
        630,
        1204,
        1770,
        2100,
        660,
        1260,
        1860,
        2220,
        720,
        1316,
        1950,
        2310,
        750,
        1372,
        2040,
        2430
      ];
      exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
        switch (errorCorrectionLevel) {
          case ECLevel.L:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
          case ECLevel.M:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
          case ECLevel.Q:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
          case ECLevel.H:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
          default:
            return void 0;
        }
      };
      exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
        switch (errorCorrectionLevel) {
          case ECLevel.L:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
          case ECLevel.M:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
          case ECLevel.Q:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
          case ECLevel.H:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
          default:
            return void 0;
        }
      };
    }
  });

  // node_modules/qrcode/lib/core/galois-field.js
  var require_galois_field = __commonJS({
    "node_modules/qrcode/lib/core/galois-field.js"(exports) {
      var EXP_TABLE = new Uint8Array(512);
      var LOG_TABLE = new Uint8Array(256);
      (function initTables() {
        let x = 1;
        for (let i = 0; i < 255; i++) {
          EXP_TABLE[i] = x;
          LOG_TABLE[x] = i;
          x <<= 1;
          if (x & 256) {
            x ^= 285;
          }
        }
        for (let i = 255; i < 512; i++) {
          EXP_TABLE[i] = EXP_TABLE[i - 255];
        }
      })();
      exports.log = function log(n) {
        if (n < 1) throw new Error("log(" + n + ")");
        return LOG_TABLE[n];
      };
      exports.exp = function exp(n) {
        return EXP_TABLE[n];
      };
      exports.mul = function mul(x, y) {
        if (x === 0 || y === 0) return 0;
        return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
      };
    }
  });

  // node_modules/qrcode/lib/core/polynomial.js
  var require_polynomial = __commonJS({
    "node_modules/qrcode/lib/core/polynomial.js"(exports) {
      var GF = require_galois_field();
      exports.mul = function mul(p1, p2) {
        const coeff = new Uint8Array(p1.length + p2.length - 1);
        for (let i = 0; i < p1.length; i++) {
          for (let j = 0; j < p2.length; j++) {
            coeff[i + j] ^= GF.mul(p1[i], p2[j]);
          }
        }
        return coeff;
      };
      exports.mod = function mod(divident, divisor) {
        let result = new Uint8Array(divident);
        while (result.length - divisor.length >= 0) {
          const coeff = result[0];
          for (let i = 0; i < divisor.length; i++) {
            result[i] ^= GF.mul(divisor[i], coeff);
          }
          let offset = 0;
          while (offset < result.length && result[offset] === 0) offset++;
          result = result.slice(offset);
        }
        return result;
      };
      exports.generateECPolynomial = function generateECPolynomial(degree) {
        let poly = new Uint8Array([1]);
        for (let i = 0; i < degree; i++) {
          poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
        }
        return poly;
      };
    }
  });

  // node_modules/qrcode/lib/core/reed-solomon-encoder.js
  var require_reed_solomon_encoder = __commonJS({
    "node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports, module) {
      var Polynomial = require_polynomial();
      function ReedSolomonEncoder(degree) {
        this.genPoly = void 0;
        this.degree = degree;
        if (this.degree) this.initialize(this.degree);
      }
      ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
        this.degree = degree;
        this.genPoly = Polynomial.generateECPolynomial(this.degree);
      };
      ReedSolomonEncoder.prototype.encode = function encode(data) {
        if (!this.genPoly) {
          throw new Error("Encoder not initialized");
        }
        const paddedData = new Uint8Array(data.length + this.degree);
        paddedData.set(data);
        const remainder = Polynomial.mod(paddedData, this.genPoly);
        const start = this.degree - remainder.length;
        if (start > 0) {
          const buff = new Uint8Array(this.degree);
          buff.set(remainder, start);
          return buff;
        }
        return remainder;
      };
      module.exports = ReedSolomonEncoder;
    }
  });

  // node_modules/qrcode/lib/core/version-check.js
  var require_version_check = __commonJS({
    "node_modules/qrcode/lib/core/version-check.js"(exports) {
      exports.isValid = function isValid(version) {
        return !isNaN(version) && version >= 1 && version <= 40;
      };
    }
  });

  // node_modules/qrcode/lib/core/regex.js
  var require_regex = __commonJS({
    "node_modules/qrcode/lib/core/regex.js"(exports) {
      var numeric = "[0-9]+";
      var alphanumeric = "[A-Z $%*+\\-./:]+";
      var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
      kanji = kanji.replace(/u/g, "\\u");
      var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
      exports.KANJI = new RegExp(kanji, "g");
      exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
      exports.BYTE = new RegExp(byte, "g");
      exports.NUMERIC = new RegExp(numeric, "g");
      exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
      var TEST_KANJI = new RegExp("^" + kanji + "$");
      var TEST_NUMERIC = new RegExp("^" + numeric + "$");
      var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
      exports.testKanji = function testKanji(str) {
        return TEST_KANJI.test(str);
      };
      exports.testNumeric = function testNumeric(str) {
        return TEST_NUMERIC.test(str);
      };
      exports.testAlphanumeric = function testAlphanumeric(str) {
        return TEST_ALPHANUMERIC.test(str);
      };
    }
  });

  // node_modules/qrcode/lib/core/mode.js
  var require_mode = __commonJS({
    "node_modules/qrcode/lib/core/mode.js"(exports) {
      var VersionCheck = require_version_check();
      var Regex = require_regex();
      exports.NUMERIC = {
        id: "Numeric",
        bit: 1 << 0,
        ccBits: [10, 12, 14]
      };
      exports.ALPHANUMERIC = {
        id: "Alphanumeric",
        bit: 1 << 1,
        ccBits: [9, 11, 13]
      };
      exports.BYTE = {
        id: "Byte",
        bit: 1 << 2,
        ccBits: [8, 16, 16]
      };
      exports.KANJI = {
        id: "Kanji",
        bit: 1 << 3,
        ccBits: [8, 10, 12]
      };
      exports.MIXED = {
        bit: -1
      };
      exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
        if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
        if (!VersionCheck.isValid(version)) {
          throw new Error("Invalid version: " + version);
        }
        if (version >= 1 && version < 10) return mode.ccBits[0];
        else if (version < 27) return mode.ccBits[1];
        return mode.ccBits[2];
      };
      exports.getBestModeForData = function getBestModeForData(dataStr) {
        if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
        else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
        else if (Regex.testKanji(dataStr)) return exports.KANJI;
        else return exports.BYTE;
      };
      exports.toString = function toString(mode) {
        if (mode && mode.id) return mode.id;
        throw new Error("Invalid mode");
      };
      exports.isValid = function isValid(mode) {
        return mode && mode.bit && mode.ccBits;
      };
      function fromString(string) {
        if (typeof string !== "string") {
          throw new Error("Param is not a string");
        }
        const lcStr = string.toLowerCase();
        switch (lcStr) {
          case "numeric":
            return exports.NUMERIC;
          case "alphanumeric":
            return exports.ALPHANUMERIC;
          case "kanji":
            return exports.KANJI;
          case "byte":
            return exports.BYTE;
          default:
            throw new Error("Unknown mode: " + string);
        }
      }
      exports.from = function from(value, defaultValue) {
        if (exports.isValid(value)) {
          return value;
        }
        try {
          return fromString(value);
        } catch (e) {
          return defaultValue;
        }
      };
    }
  });

  // node_modules/qrcode/lib/core/version.js
  var require_version = __commonJS({
    "node_modules/qrcode/lib/core/version.js"(exports) {
      var Utils = require_utils();
      var ECCode = require_error_correction_code();
      var ECLevel = require_error_correction_level();
      var Mode = require_mode();
      var VersionCheck = require_version_check();
      var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
      var G18_BCH = Utils.getBCHDigit(G18);
      function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
        for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
          if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
            return currentVersion;
          }
        }
        return void 0;
      }
      function getReservedBitsCount(mode, version) {
        return Mode.getCharCountIndicator(mode, version) + 4;
      }
      function getTotalBitsFromDataArray(segments, version) {
        let totalBits = 0;
        segments.forEach(function(data) {
          const reservedBits = getReservedBitsCount(data.mode, version);
          totalBits += reservedBits + data.getBitsLength();
        });
        return totalBits;
      }
      function getBestVersionForMixedData(segments, errorCorrectionLevel) {
        for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
          const length = getTotalBitsFromDataArray(segments, currentVersion);
          if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
            return currentVersion;
          }
        }
        return void 0;
      }
      exports.from = function from(value, defaultValue) {
        if (VersionCheck.isValid(value)) {
          return parseInt(value, 10);
        }
        return defaultValue;
      };
      exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
        if (!VersionCheck.isValid(version)) {
          throw new Error("Invalid QR Code version");
        }
        if (typeof mode === "undefined") mode = Mode.BYTE;
        const totalCodewords = Utils.getSymbolTotalCodewords(version);
        const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
        const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
        if (mode === Mode.MIXED) return dataTotalCodewordsBits;
        const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
        switch (mode) {
          case Mode.NUMERIC:
            return Math.floor(usableBits / 10 * 3);
          case Mode.ALPHANUMERIC:
            return Math.floor(usableBits / 11 * 2);
          case Mode.KANJI:
            return Math.floor(usableBits / 13);
          case Mode.BYTE:
          default:
            return Math.floor(usableBits / 8);
        }
      };
      exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
        let seg;
        const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
        if (Array.isArray(data)) {
          if (data.length > 1) {
            return getBestVersionForMixedData(data, ecl);
          }
          if (data.length === 0) {
            return 1;
          }
          seg = data[0];
        } else {
          seg = data;
        }
        return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
      };
      exports.getEncodedBits = function getEncodedBits(version) {
        if (!VersionCheck.isValid(version) || version < 7) {
          throw new Error("Invalid QR Code version");
        }
        let d = version << 12;
        while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
          d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
        }
        return version << 12 | d;
      };
    }
  });

  // node_modules/qrcode/lib/core/format-info.js
  var require_format_info = __commonJS({
    "node_modules/qrcode/lib/core/format-info.js"(exports) {
      var Utils = require_utils();
      var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
      var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
      var G15_BCH = Utils.getBCHDigit(G15);
      exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
        const data = errorCorrectionLevel.bit << 3 | mask;
        let d = data << 10;
        while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
          d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
        }
        return (data << 10 | d) ^ G15_MASK;
      };
    }
  });

  // node_modules/qrcode/lib/core/numeric-data.js
  var require_numeric_data = __commonJS({
    "node_modules/qrcode/lib/core/numeric-data.js"(exports, module) {
      var Mode = require_mode();
      function NumericData(data) {
        this.mode = Mode.NUMERIC;
        this.data = data.toString();
      }
      NumericData.getBitsLength = function getBitsLength(length) {
        return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
      };
      NumericData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      NumericData.prototype.getBitsLength = function getBitsLength() {
        return NumericData.getBitsLength(this.data.length);
      };
      NumericData.prototype.write = function write(bitBuffer) {
        let i, group, value;
        for (i = 0; i + 3 <= this.data.length; i += 3) {
          group = this.data.substr(i, 3);
          value = parseInt(group, 10);
          bitBuffer.put(value, 10);
        }
        const remainingNum = this.data.length - i;
        if (remainingNum > 0) {
          group = this.data.substr(i);
          value = parseInt(group, 10);
          bitBuffer.put(value, remainingNum * 3 + 1);
        }
      };
      module.exports = NumericData;
    }
  });

  // node_modules/qrcode/lib/core/alphanumeric-data.js
  var require_alphanumeric_data = __commonJS({
    "node_modules/qrcode/lib/core/alphanumeric-data.js"(exports, module) {
      var Mode = require_mode();
      var ALPHA_NUM_CHARS = [
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        " ",
        "$",
        "%",
        "*",
        "+",
        "-",
        ".",
        "/",
        ":"
      ];
      function AlphanumericData(data) {
        this.mode = Mode.ALPHANUMERIC;
        this.data = data;
      }
      AlphanumericData.getBitsLength = function getBitsLength(length) {
        return 11 * Math.floor(length / 2) + 6 * (length % 2);
      };
      AlphanumericData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      AlphanumericData.prototype.getBitsLength = function getBitsLength() {
        return AlphanumericData.getBitsLength(this.data.length);
      };
      AlphanumericData.prototype.write = function write(bitBuffer) {
        let i;
        for (i = 0; i + 2 <= this.data.length; i += 2) {
          let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
          value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
          bitBuffer.put(value, 11);
        }
        if (this.data.length % 2) {
          bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
        }
      };
      module.exports = AlphanumericData;
    }
  });

  // node_modules/qrcode/lib/core/byte-data.js
  var require_byte_data = __commonJS({
    "node_modules/qrcode/lib/core/byte-data.js"(exports, module) {
      var Mode = require_mode();
      function ByteData(data) {
        this.mode = Mode.BYTE;
        if (typeof data === "string") {
          this.data = new TextEncoder().encode(data);
        } else {
          this.data = new Uint8Array(data);
        }
      }
      ByteData.getBitsLength = function getBitsLength(length) {
        return length * 8;
      };
      ByteData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      ByteData.prototype.getBitsLength = function getBitsLength() {
        return ByteData.getBitsLength(this.data.length);
      };
      ByteData.prototype.write = function(bitBuffer) {
        for (let i = 0, l = this.data.length; i < l; i++) {
          bitBuffer.put(this.data[i], 8);
        }
      };
      module.exports = ByteData;
    }
  });

  // node_modules/qrcode/lib/core/kanji-data.js
  var require_kanji_data = __commonJS({
    "node_modules/qrcode/lib/core/kanji-data.js"(exports, module) {
      var Mode = require_mode();
      var Utils = require_utils();
      function KanjiData(data) {
        this.mode = Mode.KANJI;
        this.data = data;
      }
      KanjiData.getBitsLength = function getBitsLength(length) {
        return length * 13;
      };
      KanjiData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      KanjiData.prototype.getBitsLength = function getBitsLength() {
        return KanjiData.getBitsLength(this.data.length);
      };
      KanjiData.prototype.write = function(bitBuffer) {
        let i;
        for (i = 0; i < this.data.length; i++) {
          let value = Utils.toSJIS(this.data[i]);
          if (value >= 33088 && value <= 40956) {
            value -= 33088;
          } else if (value >= 57408 && value <= 60351) {
            value -= 49472;
          } else {
            throw new Error(
              "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
            );
          }
          value = (value >>> 8 & 255) * 192 + (value & 255);
          bitBuffer.put(value, 13);
        }
      };
      module.exports = KanjiData;
    }
  });

  // node_modules/dijkstrajs/dijkstra.js
  var require_dijkstra = __commonJS({
    "node_modules/dijkstrajs/dijkstra.js"(exports, module) {
      "use strict";
      var dijkstra = {
        single_source_shortest_paths: function(graph, s, d) {
          var predecessors = {};
          var costs = {};
          costs[s] = 0;
          var open = dijkstra.PriorityQueue.make();
          open.push(s, 0);
          var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
          while (!open.empty()) {
            closest = open.pop();
            u = closest.value;
            cost_of_s_to_u = closest.cost;
            adjacent_nodes = graph[u] || {};
            for (v in adjacent_nodes) {
              if (adjacent_nodes.hasOwnProperty(v)) {
                cost_of_e = adjacent_nodes[v];
                cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
                cost_of_s_to_v = costs[v];
                first_visit = typeof costs[v] === "undefined";
                if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                  costs[v] = cost_of_s_to_u_plus_cost_of_e;
                  open.push(v, cost_of_s_to_u_plus_cost_of_e);
                  predecessors[v] = u;
                }
              }
            }
          }
          if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
            var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
            throw new Error(msg);
          }
          return predecessors;
        },
        extract_shortest_path_from_predecessor_list: function(predecessors, d) {
          var nodes = [];
          var u = d;
          var predecessor;
          while (u) {
            nodes.push(u);
            predecessor = predecessors[u];
            u = predecessors[u];
          }
          nodes.reverse();
          return nodes;
        },
        find_path: function(graph, s, d) {
          var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
          return dijkstra.extract_shortest_path_from_predecessor_list(
            predecessors,
            d
          );
        },
        /**
         * A very naive priority queue implementation.
         */
        PriorityQueue: {
          make: function(opts) {
            var T = dijkstra.PriorityQueue, t = {}, key;
            opts = opts || {};
            for (key in T) {
              if (T.hasOwnProperty(key)) {
                t[key] = T[key];
              }
            }
            t.queue = [];
            t.sorter = opts.sorter || T.default_sorter;
            return t;
          },
          default_sorter: function(a, b) {
            return a.cost - b.cost;
          },
          /**
           * Add a new item to the queue and ensure the highest priority element
           * is at the front of the queue.
           */
          push: function(value, cost) {
            var item = { value, cost };
            this.queue.push(item);
            this.queue.sort(this.sorter);
          },
          /**
           * Return the highest priority element in the queue.
           */
          pop: function() {
            return this.queue.shift();
          },
          empty: function() {
            return this.queue.length === 0;
          }
        }
      };
      if (typeof module !== "undefined") {
        module.exports = dijkstra;
      }
    }
  });

  // node_modules/qrcode/lib/core/segments.js
  var require_segments = __commonJS({
    "node_modules/qrcode/lib/core/segments.js"(exports) {
      var Mode = require_mode();
      var NumericData = require_numeric_data();
      var AlphanumericData = require_alphanumeric_data();
      var ByteData = require_byte_data();
      var KanjiData = require_kanji_data();
      var Regex = require_regex();
      var Utils = require_utils();
      var dijkstra = require_dijkstra();
      function getStringByteLength(str) {
        return unescape(encodeURIComponent(str)).length;
      }
      function getSegments(regex, mode, str) {
        const segments = [];
        let result;
        while ((result = regex.exec(str)) !== null) {
          segments.push({
            data: result[0],
            index: result.index,
            mode,
            length: result[0].length
          });
        }
        return segments;
      }
      function getSegmentsFromString(dataStr) {
        const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
        const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
        let byteSegs;
        let kanjiSegs;
        if (Utils.isKanjiModeEnabled()) {
          byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
          kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
        } else {
          byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
          kanjiSegs = [];
        }
        const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
        return segs.sort(function(s1, s2) {
          return s1.index - s2.index;
        }).map(function(obj) {
          return {
            data: obj.data,
            mode: obj.mode,
            length: obj.length
          };
        });
      }
      function getSegmentBitsLength(length, mode) {
        switch (mode) {
          case Mode.NUMERIC:
            return NumericData.getBitsLength(length);
          case Mode.ALPHANUMERIC:
            return AlphanumericData.getBitsLength(length);
          case Mode.KANJI:
            return KanjiData.getBitsLength(length);
          case Mode.BYTE:
            return ByteData.getBitsLength(length);
        }
      }
      function mergeSegments(segs) {
        return segs.reduce(function(acc, curr) {
          const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
          if (prevSeg && prevSeg.mode === curr.mode) {
            acc[acc.length - 1].data += curr.data;
            return acc;
          }
          acc.push(curr);
          return acc;
        }, []);
      }
      function buildNodes(segs) {
        const nodes = [];
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          switch (seg.mode) {
            case Mode.NUMERIC:
              nodes.push([
                seg,
                { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
                { data: seg.data, mode: Mode.BYTE, length: seg.length }
              ]);
              break;
            case Mode.ALPHANUMERIC:
              nodes.push([
                seg,
                { data: seg.data, mode: Mode.BYTE, length: seg.length }
              ]);
              break;
            case Mode.KANJI:
              nodes.push([
                seg,
                { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
              ]);
              break;
            case Mode.BYTE:
              nodes.push([
                { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
              ]);
          }
        }
        return nodes;
      }
      function buildGraph(nodes, version) {
        const table = {};
        const graph = { start: {} };
        let prevNodeIds = ["start"];
        for (let i = 0; i < nodes.length; i++) {
          const nodeGroup = nodes[i];
          const currentNodeIds = [];
          for (let j = 0; j < nodeGroup.length; j++) {
            const node = nodeGroup[j];
            const key = "" + i + j;
            currentNodeIds.push(key);
            table[key] = { node, lastCount: 0 };
            graph[key] = {};
            for (let n = 0; n < prevNodeIds.length; n++) {
              const prevNodeId = prevNodeIds[n];
              if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
                graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
                table[prevNodeId].lastCount += node.length;
              } else {
                if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
                graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
              }
            }
          }
          prevNodeIds = currentNodeIds;
        }
        for (let n = 0; n < prevNodeIds.length; n++) {
          graph[prevNodeIds[n]].end = 0;
        }
        return { map: graph, table };
      }
      function buildSingleSegment(data, modesHint) {
        let mode;
        const bestMode = Mode.getBestModeForData(data);
        mode = Mode.from(modesHint, bestMode);
        if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
          throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
        }
        if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
          mode = Mode.BYTE;
        }
        switch (mode) {
          case Mode.NUMERIC:
            return new NumericData(data);
          case Mode.ALPHANUMERIC:
            return new AlphanumericData(data);
          case Mode.KANJI:
            return new KanjiData(data);
          case Mode.BYTE:
            return new ByteData(data);
        }
      }
      exports.fromArray = function fromArray(array) {
        return array.reduce(function(acc, seg) {
          if (typeof seg === "string") {
            acc.push(buildSingleSegment(seg, null));
          } else if (seg.data) {
            acc.push(buildSingleSegment(seg.data, seg.mode));
          }
          return acc;
        }, []);
      };
      exports.fromString = function fromString(data, version) {
        const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
        const nodes = buildNodes(segs);
        const graph = buildGraph(nodes, version);
        const path = dijkstra.find_path(graph.map, "start", "end");
        const optimizedSegs = [];
        for (let i = 1; i < path.length - 1; i++) {
          optimizedSegs.push(graph.table[path[i]].node);
        }
        return exports.fromArray(mergeSegments(optimizedSegs));
      };
      exports.rawSplit = function rawSplit(data) {
        return exports.fromArray(
          getSegmentsFromString(data, Utils.isKanjiModeEnabled())
        );
      };
    }
  });

  // node_modules/qrcode/lib/core/qrcode.js
  var require_qrcode = __commonJS({
    "node_modules/qrcode/lib/core/qrcode.js"(exports) {
      var Utils = require_utils();
      var ECLevel = require_error_correction_level();
      var BitBuffer = require_bit_buffer();
      var BitMatrix = require_bit_matrix();
      var AlignmentPattern = require_alignment_pattern();
      var FinderPattern = require_finder_pattern();
      var MaskPattern = require_mask_pattern();
      var ECCode = require_error_correction_code();
      var ReedSolomonEncoder = require_reed_solomon_encoder();
      var Version = require_version();
      var FormatInfo = require_format_info();
      var Mode = require_mode();
      var Segments = require_segments();
      function setupFinderPattern(matrix, version) {
        const size = matrix.size;
        const pos = FinderPattern.getPositions(version);
        for (let i = 0; i < pos.length; i++) {
          const row = pos[i][0];
          const col = pos[i][1];
          for (let r = -1; r <= 7; r++) {
            if (row + r <= -1 || size <= row + r) continue;
            for (let c = -1; c <= 7; c++) {
              if (col + c <= -1 || size <= col + c) continue;
              if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
                matrix.set(row + r, col + c, true, true);
              } else {
                matrix.set(row + r, col + c, false, true);
              }
            }
          }
        }
      }
      function setupTimingPattern(matrix) {
        const size = matrix.size;
        for (let r = 8; r < size - 8; r++) {
          const value = r % 2 === 0;
          matrix.set(r, 6, value, true);
          matrix.set(6, r, value, true);
        }
      }
      function setupAlignmentPattern(matrix, version) {
        const pos = AlignmentPattern.getPositions(version);
        for (let i = 0; i < pos.length; i++) {
          const row = pos[i][0];
          const col = pos[i][1];
          for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
              if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
                matrix.set(row + r, col + c, true, true);
              } else {
                matrix.set(row + r, col + c, false, true);
              }
            }
          }
        }
      }
      function setupVersionInfo(matrix, version) {
        const size = matrix.size;
        const bits = Version.getEncodedBits(version);
        let row, col, mod;
        for (let i = 0; i < 18; i++) {
          row = Math.floor(i / 3);
          col = i % 3 + size - 8 - 3;
          mod = (bits >> i & 1) === 1;
          matrix.set(row, col, mod, true);
          matrix.set(col, row, mod, true);
        }
      }
      function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
        const size = matrix.size;
        const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
        let i, mod;
        for (i = 0; i < 15; i++) {
          mod = (bits >> i & 1) === 1;
          if (i < 6) {
            matrix.set(i, 8, mod, true);
          } else if (i < 8) {
            matrix.set(i + 1, 8, mod, true);
          } else {
            matrix.set(size - 15 + i, 8, mod, true);
          }
          if (i < 8) {
            matrix.set(8, size - i - 1, mod, true);
          } else if (i < 9) {
            matrix.set(8, 15 - i - 1 + 1, mod, true);
          } else {
            matrix.set(8, 15 - i - 1, mod, true);
          }
        }
        matrix.set(size - 8, 8, 1, true);
      }
      function setupData(matrix, data) {
        const size = matrix.size;
        let inc = -1;
        let row = size - 1;
        let bitIndex = 7;
        let byteIndex = 0;
        for (let col = size - 1; col > 0; col -= 2) {
          if (col === 6) col--;
          while (true) {
            for (let c = 0; c < 2; c++) {
              if (!matrix.isReserved(row, col - c)) {
                let dark = false;
                if (byteIndex < data.length) {
                  dark = (data[byteIndex] >>> bitIndex & 1) === 1;
                }
                matrix.set(row, col - c, dark);
                bitIndex--;
                if (bitIndex === -1) {
                  byteIndex++;
                  bitIndex = 7;
                }
              }
            }
            row += inc;
            if (row < 0 || size <= row) {
              row -= inc;
              inc = -inc;
              break;
            }
          }
        }
      }
      function createData(version, errorCorrectionLevel, segments) {
        const buffer = new BitBuffer();
        segments.forEach(function(data) {
          buffer.put(data.mode.bit, 4);
          buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
          data.write(buffer);
        });
        const totalCodewords = Utils.getSymbolTotalCodewords(version);
        const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
        const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
        if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
          buffer.put(0, 4);
        }
        while (buffer.getLengthInBits() % 8 !== 0) {
          buffer.putBit(0);
        }
        const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
        for (let i = 0; i < remainingByte; i++) {
          buffer.put(i % 2 ? 17 : 236, 8);
        }
        return createCodewords(buffer, version, errorCorrectionLevel);
      }
      function createCodewords(bitBuffer, version, errorCorrectionLevel) {
        const totalCodewords = Utils.getSymbolTotalCodewords(version);
        const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
        const dataTotalCodewords = totalCodewords - ecTotalCodewords;
        const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
        const blocksInGroup2 = totalCodewords % ecTotalBlocks;
        const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
        const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
        const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
        const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
        const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
        const rs = new ReedSolomonEncoder(ecCount);
        let offset = 0;
        const dcData = new Array(ecTotalBlocks);
        const ecData = new Array(ecTotalBlocks);
        let maxDataSize = 0;
        const buffer = new Uint8Array(bitBuffer.buffer);
        for (let b = 0; b < ecTotalBlocks; b++) {
          const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
          dcData[b] = buffer.slice(offset, offset + dataSize);
          ecData[b] = rs.encode(dcData[b]);
          offset += dataSize;
          maxDataSize = Math.max(maxDataSize, dataSize);
        }
        const data = new Uint8Array(totalCodewords);
        let index = 0;
        let i, r;
        for (i = 0; i < maxDataSize; i++) {
          for (r = 0; r < ecTotalBlocks; r++) {
            if (i < dcData[r].length) {
              data[index++] = dcData[r][i];
            }
          }
        }
        for (i = 0; i < ecCount; i++) {
          for (r = 0; r < ecTotalBlocks; r++) {
            data[index++] = ecData[r][i];
          }
        }
        return data;
      }
      function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
        let segments;
        if (Array.isArray(data)) {
          segments = Segments.fromArray(data);
        } else if (typeof data === "string") {
          let estimatedVersion = version;
          if (!estimatedVersion) {
            const rawSegments = Segments.rawSplit(data);
            estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
          }
          segments = Segments.fromString(data, estimatedVersion || 40);
        } else {
          throw new Error("Invalid data");
        }
        const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
        if (!bestVersion) {
          throw new Error("The amount of data is too big to be stored in a QR Code");
        }
        if (!version) {
          version = bestVersion;
        } else if (version < bestVersion) {
          throw new Error(
            "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
          );
        }
        const dataBits = createData(version, errorCorrectionLevel, segments);
        const moduleCount = Utils.getSymbolSize(version);
        const modules = new BitMatrix(moduleCount);
        setupFinderPattern(modules, version);
        setupTimingPattern(modules);
        setupAlignmentPattern(modules, version);
        setupFormatInfo(modules, errorCorrectionLevel, 0);
        if (version >= 7) {
          setupVersionInfo(modules, version);
        }
        setupData(modules, dataBits);
        if (isNaN(maskPattern)) {
          maskPattern = MaskPattern.getBestMask(
            modules,
            setupFormatInfo.bind(null, modules, errorCorrectionLevel)
          );
        }
        MaskPattern.applyMask(maskPattern, modules);
        setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
        return {
          modules,
          version,
          errorCorrectionLevel,
          maskPattern,
          segments
        };
      }
      exports.create = function create(data, options) {
        if (typeof data === "undefined" || data === "") {
          throw new Error("No input text");
        }
        let errorCorrectionLevel = ECLevel.M;
        let version;
        let mask;
        if (typeof options !== "undefined") {
          errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
          version = Version.from(options.version);
          mask = MaskPattern.from(options.maskPattern);
          if (options.toSJISFunc) {
            Utils.setToSJISFunction(options.toSJISFunc);
          }
        }
        return createSymbol(data, version, errorCorrectionLevel, mask);
      };
    }
  });

  // node_modules/qrcode/lib/renderer/utils.js
  var require_utils2 = __commonJS({
    "node_modules/qrcode/lib/renderer/utils.js"(exports) {
      function hex2rgba(hex) {
        if (typeof hex === "number") {
          hex = hex.toString();
        }
        if (typeof hex !== "string") {
          throw new Error("Color should be defined as hex string");
        }
        let hexCode = hex.slice().replace("#", "").split("");
        if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
          throw new Error("Invalid hex color: " + hex);
        }
        if (hexCode.length === 3 || hexCode.length === 4) {
          hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
            return [c, c];
          }));
        }
        if (hexCode.length === 6) hexCode.push("F", "F");
        const hexValue = parseInt(hexCode.join(""), 16);
        return {
          r: hexValue >> 24 & 255,
          g: hexValue >> 16 & 255,
          b: hexValue >> 8 & 255,
          a: hexValue & 255,
          hex: "#" + hexCode.slice(0, 6).join("")
        };
      }
      exports.getOptions = function getOptions(options) {
        if (!options) options = {};
        if (!options.color) options.color = {};
        const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
        const width = options.width && options.width >= 21 ? options.width : void 0;
        const scale = options.scale || 4;
        return {
          width,
          scale: width ? 4 : scale,
          margin,
          color: {
            dark: hex2rgba(options.color.dark || "#000000ff"),
            light: hex2rgba(options.color.light || "#ffffffff")
          },
          type: options.type,
          rendererOpts: options.rendererOpts || {}
        };
      };
      exports.getScale = function getScale(qrSize, opts) {
        return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
      };
      exports.getImageWidth = function getImageWidth(qrSize, opts) {
        const scale = exports.getScale(qrSize, opts);
        return Math.floor((qrSize + opts.margin * 2) * scale);
      };
      exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
        const size = qr.modules.size;
        const data = qr.modules.data;
        const scale = exports.getScale(size, opts);
        const symbolSize = Math.floor((size + opts.margin * 2) * scale);
        const scaledMargin = opts.margin * scale;
        const palette = [opts.color.light, opts.color.dark];
        for (let i = 0; i < symbolSize; i++) {
          for (let j = 0; j < symbolSize; j++) {
            let posDst = (i * symbolSize + j) * 4;
            let pxColor = opts.color.light;
            if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
              const iSrc = Math.floor((i - scaledMargin) / scale);
              const jSrc = Math.floor((j - scaledMargin) / scale);
              pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
            }
            imgData[posDst++] = pxColor.r;
            imgData[posDst++] = pxColor.g;
            imgData[posDst++] = pxColor.b;
            imgData[posDst] = pxColor.a;
          }
        }
      };
    }
  });

  // node_modules/qrcode/lib/renderer/canvas.js
  var require_canvas = __commonJS({
    "node_modules/qrcode/lib/renderer/canvas.js"(exports) {
      var Utils = require_utils2();
      function clearCanvas(ctx, canvas, size) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!canvas.style) canvas.style = {};
        canvas.height = size;
        canvas.width = size;
        canvas.style.height = size + "px";
        canvas.style.width = size + "px";
      }
      function getCanvasElement() {
        try {
          return document.createElement("canvas");
        } catch (e) {
          throw new Error("You need to specify a canvas element");
        }
      }
      exports.render = function render(qrData, canvas, options) {
        let opts = options;
        let canvasEl = canvas;
        if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
          opts = canvas;
          canvas = void 0;
        }
        if (!canvas) {
          canvasEl = getCanvasElement();
        }
        opts = Utils.getOptions(opts);
        const size = Utils.getImageWidth(qrData.modules.size, opts);
        const ctx = canvasEl.getContext("2d");
        const image = ctx.createImageData(size, size);
        Utils.qrToImageData(image.data, qrData, opts);
        clearCanvas(ctx, canvasEl, size);
        ctx.putImageData(image, 0, 0);
        return canvasEl;
      };
      exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
        let opts = options;
        if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
          opts = canvas;
          canvas = void 0;
        }
        if (!opts) opts = {};
        const canvasEl = exports.render(qrData, canvas, opts);
        const type = opts.type || "image/png";
        const rendererOpts = opts.rendererOpts || {};
        return canvasEl.toDataURL(type, rendererOpts.quality);
      };
    }
  });

  // node_modules/qrcode/lib/renderer/svg-tag.js
  var require_svg_tag = __commonJS({
    "node_modules/qrcode/lib/renderer/svg-tag.js"(exports) {
      var Utils = require_utils2();
      function getColorAttrib(color, attrib) {
        const alpha = color.a / 255;
        const str = attrib + '="' + color.hex + '"';
        return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
      }
      function svgCmd(cmd, x, y) {
        let str = cmd + x;
        if (typeof y !== "undefined") str += " " + y;
        return str;
      }
      function qrToPath(data, size, margin) {
        let path = "";
        let moveBy = 0;
        let newRow = false;
        let lineLength = 0;
        for (let i = 0; i < data.length; i++) {
          const col = Math.floor(i % size);
          const row = Math.floor(i / size);
          if (!col && !newRow) newRow = true;
          if (data[i]) {
            lineLength++;
            if (!(i > 0 && col > 0 && data[i - 1])) {
              path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
              moveBy = 0;
              newRow = false;
            }
            if (!(col + 1 < size && data[i + 1])) {
              path += svgCmd("h", lineLength);
              lineLength = 0;
            }
          } else {
            moveBy++;
          }
        }
        return path;
      }
      exports.render = function render(qrData, options, cb) {
        const opts = Utils.getOptions(options);
        const size = qrData.modules.size;
        const data = qrData.modules.data;
        const qrcodesize = size + opts.margin * 2;
        const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
        const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
        const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
        const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
        const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
        if (typeof cb === "function") {
          cb(null, svgTag);
        }
        return svgTag;
      };
    }
  });

  // node_modules/qrcode/lib/browser.js
  var require_browser = __commonJS({
    "node_modules/qrcode/lib/browser.js"(exports) {
      var canPromise = require_can_promise();
      var QRCode2 = require_qrcode();
      var CanvasRenderer = require_canvas();
      var SvgRenderer = require_svg_tag();
      function renderCanvas(renderFunc, canvas, text, opts, cb) {
        const args = [].slice.call(arguments, 1);
        const argsNum = args.length;
        const isLastArgCb = typeof args[argsNum - 1] === "function";
        if (!isLastArgCb && !canPromise()) {
          throw new Error("Callback required as last argument");
        }
        if (isLastArgCb) {
          if (argsNum < 2) {
            throw new Error("Too few arguments provided");
          }
          if (argsNum === 2) {
            cb = text;
            text = canvas;
            canvas = opts = void 0;
          } else if (argsNum === 3) {
            if (canvas.getContext && typeof cb === "undefined") {
              cb = opts;
              opts = void 0;
            } else {
              cb = opts;
              opts = text;
              text = canvas;
              canvas = void 0;
            }
          }
        } else {
          if (argsNum < 1) {
            throw new Error("Too few arguments provided");
          }
          if (argsNum === 1) {
            text = canvas;
            canvas = opts = void 0;
          } else if (argsNum === 2 && !canvas.getContext) {
            opts = text;
            text = canvas;
            canvas = void 0;
          }
          return new Promise(function(resolve, reject) {
            try {
              const data = QRCode2.create(text, opts);
              resolve(renderFunc(data, canvas, opts));
            } catch (e) {
              reject(e);
            }
          });
        }
        try {
          const data = QRCode2.create(text, opts);
          cb(null, renderFunc(data, canvas, opts));
        } catch (e) {
          cb(e);
        }
      }
      exports.create = QRCode2.create;
      exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
      exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
      exports.toString = renderCanvas.bind(null, function(data, _, opts) {
        return SvgRenderer.render(data, opts);
      });
    }
  });

  // local-ui/renderer/wallet-entry.mjs
  var import_qrcode = __toESM(require_browser(), 1);

  // account/credit-wallet.mjs
  var MAX_ATOMS = 9223372036854775807n;
  var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  var fail = (code, status = 422) => Object.assign(new Error(code), { code, status });
  var invalid = () => fail("CREDITS_INVALID_RESPONSE", 502);
  function creditAtoms(value) {
    if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw invalid();
    const amount = BigInt(value);
    if (amount < -MAX_ATOMS || amount > MAX_ATOMS) throw invalid();
    return amount;
  }
  function orderGrantCreditAtoms(order) {
    const display = order.credit_display;
    if (display === null) return null;
    if (display === void 0) {
      if (creditAtoms(order.grant_credit_atoms) <= 0n) throw invalid();
      return order.grant_credit_atoms;
    }
    if (!object(display) || !["usd-credit-1-v1", "usd-credit-100-v2"].includes(display.currency_rule_id) || display.credit_scale !== 6 || creditAtoms(display.grant_credit_atoms) <= 0n) throw invalid();
    return display.grant_credit_atoms;
  }
  function formatCreditAtoms(value) {
    const amount = creditAtoms(value);
    const magnitude = amount < 0n ? -amount : amount;
    const sign = amount < 0n ? "-" : "";
    const direction = amount < 0n ? "debt" : amount > 0n ? "credit" : "zero";
    const exact = `${sign}${magnitude / 1000000n}.${String(magnitude % 1000000n).padStart(6, "0")}`;
    if (magnitude > 0n && magnitude < 1000000n) return { text: "<1", direction, exact };
    const whole = ((magnitude + 500000n) / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return { text: `${sign}${whole}`, direction, exact };
  }
  function displayCreditAtoms(value, context = "balance") {
    const formatted = formatCreditAtoms(value);
    if (context === "consumption") {
      const amount = creditAtoms(value);
      if (amount === 0n) return "0.00";
      const magnitude = amount < 0n ? -amount : amount;
      const rounded = (magnitude + 5000n) / 10000n;
      if (rounded === 0n) return `${formatted.direction === "debt" ? "\u6B20\u8D39" : "\u6D88\u8017"}\u4E0D\u8DB3 0.01 \u79EF\u5206`;
      const whole = (rounded / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return `${amount < 0n ? "-" : ""}${whole}.${String(rounded % 100n).padStart(2, "0")}`;
    }
    if (formatted.text !== "<1") return formatted.text;
    return `${formatted.direction === "debt" ? "\u6B20\u8D39" : "\u4F59\u989D"}\u4E0D\u8DB3 1 \u79EF\u5206`;
  }
  function validateCreditWallet(value, accountId) {
    if (!object(value) || value.view_version !== "2" || value.currency_rule_id !== "usd-credit-100-v2" || value.credit_scale !== 6 || typeof value.account_id !== "string" || accountId && value.account_id !== accountId || !["pending", "stale", "synced"].includes(value.sync_state) || !Number.isSafeInteger(value.pending_executions) || value.pending_executions < 0 || creditAtoms(value.remote_sequence) < 0n) throw invalid();
    for (const field of ["balance_credit_atoms", "spent_credit_atoms", "correction_credit_atoms", "net_spent_credit_atoms"]) {
      if (value.sync_state === "pending") {
        if (value[field] !== null) throw invalid();
      } else creditAtoms(value[field]);
    }
    if (value.sync_state !== "pending" && (!Number.isFinite(Date.parse(value.synced_at)) || creditAtoms(value.spent_credit_atoms) < 0n || creditAtoms(value.correction_credit_atoms) < 0n || creditAtoms(value.spent_credit_atoms) - creditAtoms(value.correction_credit_atoms) !== creditAtoms(value.net_spent_credit_atoms))) throw invalid();
    return value;
  }

  // local-ui/renderer/wallet-view.mjs
  var esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  var pendingOrder = (value) => value && !["credited", "closed"].includes(value.display_state);
  function createWalletView({
    request,
    changed,
    storage = globalThis.localStorage,
    uuid = () => globalThis.crypto.randomUUID(),
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
    qr,
    getBoxName = (deviceId) => deviceId,
    onTiming = () => {
    },
    monotonic = () => globalThis.performance?.now?.() ?? now()
  }) {
    let identity = null, account = null, generation = 0, timer = null, qrTimer = null, loading = false, writing = false;
    let catalog = null, balance = null, order = null, dialogOpen = false, selectedAmount = null;
    let error = "", intent = null, qrImage = null, recoveryReady = false, recovering = false;
    let checkingOrder = false, orderReadFailed = false, customAmount = "", customText = "", customQuote = null;
    let backgroundLoading = false, recoveryTask = null, confirmingPurchase = false;
    let cancellationAccepted = false, cancellationClosed = false;
    let selectedChannel = "alipay", remote = null, usage = [], nextUsage = null, usageLoading = false;
    const channels = () => catalog?.payment_channels?.filter((name) => ["alipay", "wechat"].includes(name)) ?? ["alipay"];
    const key = () => `wanx.credit.purchase.v1:${account}`;
    const data = (response) => {
      if (response?.schema_version !== "1" || !response.data || !response.request_id) throw new Error("CREDITS_INVALID_RESPONSE");
      return response.data;
    };
    const read = async (name, input) => data(await request(`wallet.${name}`, input));
    const amount = (value) => displayCreditAtoms(value);
    const notify = () => changed();
    const timing = (stage, started, details = {}) => {
      try {
        onTiming({ stage, durationMs: Math.max(0, Math.round(monotonic() - started)), ...details });
      } catch {
      }
    };
    const visibleLoading = () => loading && !backgroundLoading;
    const visibleRecovery = () => recovering && !backgroundLoading;
    function message(cause, fallback = "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u79EF\u5206\u670D\u52A1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002") {
      const code = cause?.code || cause?.message;
      const messages = {
        CONTRACT_NOT_CONFIGURED: "\u79EF\u5206\u670D\u52A1\u6682\u672A\u5F00\u653E\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002",
        QEETOKEN_UNAVAILABLE: "\u4F59\u989D\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u6B63\u5728\u91CD\u8BD5\u540C\u6B65\u3002",
        QEETOKEN_MIGRATION_PENDING: "\u65E7\u8C03\u7528\u6B63\u5728\u7ED3\u7B97\uFF0C\u5B8C\u6210\u540E\u5C06\u540C\u6B65\u8D26\u53F7\u4F59\u989D\u3002",
        QEETOKEN_SYNC_PENDING: "\u6D88\u8D39\u6D41\u6C34\u6B63\u5728\u540C\u6B65\uFF0C\u8BF7\u7A0D\u5019\u3002",
        CREDITS_SERVICE_UNAVAILABLE: "\u79EF\u5206\u63A5\u53E3\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u68C0\u67E5\u670D\u52A1\u90E8\u7F72\u3002",
        REVISION_CONFLICT: "\u5546\u54C1\u5DF2\u8C03\u6574\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u9009\u62E9\u3002",
        UNSUPPORTED_SCHEMA: "\u79EF\u5206\u8D2D\u4E70\u89C4\u5219\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u5546\u54C1\u6216\u83B7\u53D6\u62A5\u4EF7\u3002",
        VALIDATION_ERROR: "\u8D2D\u4E70\u91D1\u989D\u6216\u5546\u54C1\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u3002",
        ORDER_IN_PROGRESS: "\u8D26\u53F7\u5DF2\u6709\u8D2D\u4E70\u6D41\u7A0B\uFF0C\u6B63\u5728\u6062\u590D\u539F\u8BA2\u5355\u3002",
        ORDER_ALREADY_PAID: "\u8BA2\u5355\u5DF2\u652F\u4ED8\uFF0C\u8BF7\u7B49\u5F85\u5230\u8D26\u3002",
        ACCOUNT_SESSION_CHANGED: "\u8D26\u53F7\u5DF2\u5207\u6362\uFF0C\u8BF7\u5237\u65B0\u3002",
        UNAUTHORIZED: "\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002",
        INTENT_STORAGE_FAILED: "\u65E0\u6CD5\u4FDD\u5B58\u8D2D\u4E70\u610F\u56FE\uFF0C\u8BF7\u6062\u590D\u672C\u5730\u5B58\u50A8\u540E\u91CD\u8BD5\uFF1B\u5C1A\u672A\u63D0\u4EA4\u65B0\u8D2D\u4E70\u8BF7\u6C42\u3002",
        CREDITS_INVALID_RESPONSE: "\u79EF\u5206\u54CD\u5E94\u65E0\u6CD5\u6821\u9A8C\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5\u3002"
      };
      return (messages[code] || fallback) + (cause?.request_id ? ` \u8BF7\u6C42\u8FFD\u8E2A\u53F7\uFF1A${cause.request_id}` : "");
    }
    function save(value) {
      try {
        if (value) storage.setItem(key(), JSON.stringify(value));
        else storage.removeItem(key());
      } catch {
        throw new Error("INTENT_STORAGE_FAILED");
      }
      intent = value;
    }
    function load() {
      try {
        const value = JSON.parse(storage.getItem(key()) || "null");
        if (value && typeof value.purchase_intent_id === "string" && (typeof value.order_id === "string" && typeof value.close_intent_id === "string" || typeof value.product_id === "string" && typeof value.product_version === "string" || value.currency_rule_id === "usd-credit-100-v2" && Number.isSafeInteger(value.amount_fen) && value.amount_fen >= 1e3 && value.amount_fen <= 1e5 && value.amount_fen % 100 === 0 || Number.isSafeInteger(value.custom_amount_fen) && value.custom_amount_fen > 0 && typeof value.custom_recharge_version === "string" || [5e3, 1e4, 2e4].includes(value.amount_fen))) return value;
      } catch {
      }
      return null;
    }
    function discardRejectedIntent(cause) {
      if (intent && !intent.order_id && !pendingOrder(order) && ["REVISION_CONFLICT", "CONTRACT_NOT_CONFIGURED", "VALIDATION_ERROR", "UNSUPPORTED_SCHEMA"].includes(cause?.code || cause?.message)) save(null);
    }
    async function acceptOrder(value, g) {
      if (g !== generation) return;
      if (qrTimer !== null) cancel(qrTimer);
      const cachedImage = order?.order_id === value.order_id && order?.payment_action?.payload === value.payment_action?.payload ? qrImage : null;
      qrTimer = null;
      order = value;
      qrImage = null;
      if (value.purchase_released === true && ["close_pending", "closed"].includes(value.payment_state) && ["close_pending", "closed"].includes(value.display_state) && value.fulfillment_state === "not_due" && ["none", "resolved"].includes(value.review_state)) {
        if (intent) save(null);
        order = null;
        cancellationAccepted = true;
        cancellationClosed = value.payment_state === "closed";
        return;
      }
      cancellationAccepted = cancellationClosed = false;
      if (value.payment_channel) selectedChannel = value.payment_channel;
      const grant = orderGrantCreditAtoms(value);
      if (intent) {
        if (value.display_state === "closed" || value.display_state === "credited" && grant !== null) save(null);
        else save({ ...intent, order_id: value.order_id });
      }
      const action = value.payment_action;
      if (!intent?.close_intent_id && action?.type === "qr" && value.payment_state === "pending" && now() < Date.parse(value.expires_at) && now() < Date.parse(action.expires_at) && qr) {
        let image = cachedImage;
        if (!image) {
          const qrStarted = monotonic();
          let outcome = "failed";
          try {
            image = await qr(action.payload);
            outcome = "completed";
          } finally {
            timing("qr", qrStarted, { outcome, ready: Boolean(image) });
          }
        }
        if (g === generation && order === value) {
          qrImage = image;
          const remaining = Math.min(Date.parse(value.expires_at), Date.parse(action.expires_at)) - now();
          if (remaining <= 0) qrImage = null;
          else qrTimer = schedule(() => {
            if (g === generation && order === value) {
              qrImage = null;
              qrTimer = null;
              notify();
            }
          }, remaining);
        }
      }
    }
    function poll() {
      if (timer !== null) cancel(timer);
      timer = null;
      if (identity) {
        const creating = order?.payment_state === "creating" && !intent?.close_intent_id;
        timer = schedule(
          () => {
            timer = null;
            void (creating ? refreshOrder() : refresh({ background: true }));
          },
          creating ? orderReadFailed ? 5e3 : 1e3 : error || !pendingOrder(order) && !intent && !remote ? 3e4 : 5e3
        );
        timer?.unref?.();
      }
    }
    async function refreshOrder() {
      if (!identity || recovering || writing || checkingOrder || !pendingOrder(order)) return;
      const g = generation;
      checkingOrder = true;
      try {
        await acceptOrder(await read("order", { order_id: order.order_id }), g);
        if (g === generation) orderReadFailed = false;
      } catch (cause) {
        if (g === generation) {
          orderReadFailed = true;
          error = message(cause);
        }
      } finally {
        if (g === generation) {
          checkingOrder = false;
          notify();
          poll();
          if (!pendingOrder(order)) void refresh({ background: true });
        }
      }
    }
    async function recover(g) {
      let value;
      if (intent?.close_intent_id && intent.order_id) {
        try {
          value = await read("closeOrder", { order_id: intent.order_id, close_intent_id: intent.close_intent_id });
        } catch (cause) {
          if (g !== generation) return;
          if (cause?.code !== "ORDER_ALREADY_PAID") throw cause;
          value = await read("order", { order_id: intent.order_id });
        }
      } else if (intent) {
        value = intent.order_id ? await read("order", { order_id: intent.order_id }) : await read("createOrder", {
          purchase_intent_id: intent.purchase_intent_id,
          ...intent.custom_recharge_version ? { custom_amount_fen: intent.custom_amount_fen, custom_recharge_version: intent.custom_recharge_version } : intent.product_id ? { product_id: intent.product_id, product_version: intent.product_version } : { amount_fen: intent.amount_fen },
          ...intent.currency_rule_id ? { currency_rule_id: intent.currency_rule_id } : {},
          ...intent.payment_channel ? { payment_channel: intent.payment_channel } : {}
        });
      } else if (pendingOrder(order)) {
        value = await read("order", { order_id: order.order_id });
      } else {
        const active = await read("orders", { active: true });
        value = active.items[0];
      }
      if (value) await acceptOrder(value, g);
      if (g === generation) orderReadFailed = false;
    }
    async function refresh({ background = false } = {}) {
      if (!identity || loading || writing || checkingOrder) return;
      const g = generation, previousError = error;
      let failure = "";
      loading = recovering = true;
      backgroundLoading = background && Boolean(catalog);
      if (!backgroundLoading) error = "";
      notify();
      try {
        recoveryTask = (async () => {
          try {
            await recover(g);
            if (g === generation) recoveryReady = true;
          } catch (cause) {
            if (g === generation) {
              discardRejectedIntent(cause);
              recoveryReady = false;
              orderReadFailed = true;
              failure = message(cause);
              if (!backgroundLoading) error = failure;
            }
          } finally {
            if (g === generation) {
              recovering = false;
              notify();
            }
          }
        })();
        await recoveryTask;
        if (g !== generation) return;
        recoveryTask = null;
        if (order?.payment_state === "creating") poll();
        const [, b] = await Promise.all([read("catalog").then((c) => {
          if (g !== generation) return;
          catalog = c;
          if (!pendingOrder(order) && !intent && !channels().includes(selectedChannel)) selectedChannel = channels()[0];
          notify();
        }), read("balance")]);
        if (g !== generation) return;
        creditAtoms(b.balance_credit_atoms);
        creditAtoms(b.debt_credit_atoms);
        if (!Number.isSafeInteger(b.ledger_sequence) || b.ledger_sequence < 0) throw new Error("CREDITS_INVALID_RESPONSE");
        let q = null, u = null;
        if (b.billing_backend === "qeetoken") {
          u = await read("usage", { limit: 20 });
          if (g !== generation) return;
          q = await read("wallet");
          if (g !== generation) return;
          validateUsage(u);
          if (q.view_version === "2") validateCreditWallet(q, account);
          else validateWalletLegacy(q);
          if (q.view_version === "2" && q.sync_state !== "pending" && BigInt(u.remote_sequence) > BigInt(q.remote_sequence)) {
            q = { ...q, sync_state: "stale" };
            u = null;
          }
        }
        if (!remote || !q || BigInt(q.remote_sequence) >= BigInt(remote.remote_sequence)) {
          remote = q;
          if (u) {
            usage = u.items;
            nextUsage = u.next_before_sequence;
          }
        }
        if (!balance || b.ledger_sequence >= balance.ledger_sequence) balance = b;
      } catch (cause) {
        if (g === generation) failure = message(cause);
      } finally {
        if (g === generation) {
          if (failure) error = failure;
          else if (backgroundLoading && error === previousError) error = "";
          loading = recovering = backgroundLoading = false;
          recoveryTask = null;
          notify();
          poll();
        }
      }
    }
    function validateWalletLegacy(q) {
      if (q.account_id !== account || q.currency_rule_id !== "usd-credit-1-v1" || q.currency !== "USD" || q.currency_scale !== 8 || q.credit_scale !== 6 || q.usd_per_credit !== "1" || !["pending", "stale", "synced"].includes(q.sync_state) || !Number.isSafeInteger(q.pending_executions) || q.pending_executions < 0 || typeof q.remote_sequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(q.remote_sequence)) throw new Error("CREDITS_INVALID_RESPONSE");
      if (q.sync_state === "pending") {
        if (q.balance_credit_atoms !== null || q.balance_usd_atoms !== null) throw new Error("CREDITS_INVALID_RESPONSE");
      } else {
        creditAtoms(q.balance_credit_atoms);
        creditAtoms(q.balance_usd_atoms);
        creditAtoms(q.spent_usd_atoms);
        if (!Number.isFinite(Date.parse(q.synced_at))) throw new Error("CREDITS_INVALID_RESPONSE");
      }
    }
    function validateUsage(value) {
      if (value.view_version === void 0) {
        if (!Array.isArray(value.items) || value.items.length > 100 || value.next_before_sequence !== null && !/^[1-9][0-9]*$/.test(value.next_before_sequence)) throw new Error("CREDITS_INVALID_RESPONSE");
        for (const item of value.items) {
          creditAtoms(item.debit_usd_atoms);
          creditAtoms(item.debit_credit_atoms);
          if (!Number.isFinite(Date.parse(item.occurred_at)) || !/^[1-9][0-9]*$/.test(item.account_sequence)) throw new Error("CREDITS_INVALID_RESPONSE");
        }
        return;
      }
      if (value.view_version !== "2" || value.account_id !== account || value.currency_rule_id !== "usd-credit-100-v2" || value.credit_scale !== 6 || typeof value.remote_sequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.remote_sequence) || !Array.isArray(value.items) || value.items.length > 100 || value.next_before_sequence !== null && !/^[1-9][0-9]*$/.test(value.next_before_sequence)) throw new Error("CREDITS_INVALID_RESPONSE");
      let previous = BigInt(value.remote_sequence) + 1n;
      for (const item of value.items) {
        creditAtoms(item.debit_credit_atoms);
        if (!Number.isFinite(Date.parse(item.occurred_at)) || !/^[1-9][0-9]*$/.test(item.account_sequence) || BigInt(item.account_sequence) >= previous || typeof item.device_id !== "string" || typeof item.model !== "string") throw new Error("CREDITS_INVALID_RESPONSE");
        previous = BigInt(item.account_sequence);
      }
    }
    const displayedBalance = () => remote ? remote.balance_credit_atoms : balance?.billing_backend === "qeetoken" ? null : balance?.balance_credit_atoms;
    const date = (value) => new Intl.DateTimeFormat("zh-CN", { timeZone: catalog?.timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
    async function loadUsage() {
      if (!identity || usageLoading || !nextUsage) return;
      const g = generation, cursor = nextUsage;
      usageLoading = true;
      try {
        const value = await read("usage", { before_sequence: cursor, limit: 20 });
        if (g !== generation || cursor !== nextUsage) return;
        validateUsage(value);
        usage.push(...value.items);
        nextUsage = value.next_before_sequence;
      } catch (cause) {
        if (g === generation) error = message(cause);
      } finally {
        if (g === generation) {
          usageLoading = false;
          notify();
        }
      }
    }
    function remoteView() {
      if (!remote) return "";
      if (remote.currency_rule_id === "usd-credit-1-v1") return legacyRemoteView();
      const state = remote.sync_state === "pending" ? "\u4F59\u989D\u521D\u59CB\u5316\u4E2D" : remote.sync_state === "stale" || error ? "\u663E\u793A\u4E0A\u6B21\u540C\u6B65\u4F59\u989D" : "\u4F59\u989D\u5DF2\u540C\u6B65";
      return `<section aria-label="\u4F59\u989D\u540C\u6B65\u72B6\u6001"><p>${esc(state)}${remote.synced_at ? ` \xB7 ${esc(date(remote.synced_at))}` : ""}</p>
      ${registrationView()}
      ${typeof remote.spent_credit_atoms === "string" ? `<p class="muted">\u7D2F\u8BA1\u6D88\u8017 ${esc(displayCreditAtoms(remote.spent_credit_atoms, "consumption"))} \xB7 \u5DF2\u7EA0\u6B63 ${esc(displayCreditAtoms(remote.correction_credit_atoms))} \xB7 \u51C0\u6D88\u8017 ${esc(displayCreditAtoms(remote.net_spent_credit_atoms, "consumption"))}</p>` : ""}
      ${remote.pending_executions ? `<p role="status">${esc(remote.pending_executions)} \u7B14\u8C03\u7528\u6B63\u5728\u7ED3\u7B97\u6216\u6838\u5BF9\uFF0C\u6700\u7EC8\u6D88\u8017\u4EE5\u7ED3\u7B97\u7ED3\u679C\u4E3A\u51C6\u3002</p>` : ""}</section>
      <section class="wallet-usage" aria-label="\u6D88\u8D39\u6D41\u6C34"><h3>\u6D88\u8D39\u6D41\u6C34</h3>${usage.length ? `<div class="wallet-usage-scroll" tabindex="0" aria-label="\u53EF\u6EDA\u52A8\u6D88\u8D39\u8BB0\u5F55"><table><thead><tr><th>\u65F6\u95F4</th><th>\u76D2\u5B50</th><th>\u6A21\u578B</th><th>\u6D88\u8017\u79EF\u5206</th></tr></thead><tbody>${usage.map((item) => `<tr><td>${esc(date(item.occurred_at))}</td><td>${esc(getBoxName(item.device_id) || item.device_id)}</td><td>${esc(item.model)}</td><td>${esc(displayCreditAtoms(item.debit_credit_atoms, "consumption"))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">\u6682\u65E0\u5DF2\u7ED3\u7B97\u6D88\u8D39\u3002</p>'}
      ${nextUsage ? `<button class="text-button" data-action="credits-usage-more" ${usageLoading ? "disabled" : ""}>\u67E5\u770B\u66F4\u591A</button>` : ""}</section>`;
    }
    const usd = (value) => {
      const atoms = creditAtoms(value), magnitude = atoms < 0n ? -atoms : atoms;
      return `${atoms < 0n ? "-" : ""}${magnitude / 100000000n}.${String(magnitude % 100000000n).padStart(8, "0")}`;
    };
    function legacyRemoteView() {
      const state = remote.sync_state === "pending" ? "\u4F59\u989D\u521D\u59CB\u5316\u4E2D" : remote.sync_state === "stale" || error ? "\u663E\u793A\u4E0A\u6B21\u540C\u6B65\u4F59\u989D" : "\u4F59\u989D\u5DF2\u540C\u6B65";
      return `<section aria-label="\u4F59\u989D\u540C\u6B65\u72B6\u6001"><p>${esc(state)}${remote.synced_at ? ` \xB7 ${esc(date(remote.synced_at))}` : ""}</p>
      <p class="muted">1 USD = 1 \u79EF\u5206${remote.balance_usd_atoms !== null ? ` \xB7 \u4F59\u989D $${esc(usd(remote.balance_usd_atoms))} \xB7 \u7D2F\u8BA1\u6D88\u8017 $${esc(usd(remote.spent_usd_atoms))}` : ""}</p>
      ${remote.pending_executions ? `<p role="status">${esc(remote.pending_executions)} \u7B14\u8C03\u7528\u6B63\u5728\u7ED3\u7B97\u6216\u6838\u5BF9\uFF0C\u6700\u7EC8\u6D88\u8017\u4EE5\u7ED3\u7B97\u7ED3\u679C\u4E3A\u51C6\u3002</p>` : ""}</section>
      <section class="wallet-usage" aria-label="\u6D88\u8D39\u6D41\u6C34"><h3>\u6D88\u8D39\u6D41\u6C34</h3>${usage.length ? `<div class="wallet-usage-scroll" tabindex="0" aria-label="\u53EF\u6EDA\u52A8\u6D88\u8D39\u8BB0\u5F55"><table><thead><tr><th>\u65F6\u95F4</th><th>\u76D2\u5B50</th><th>\u6A21\u578B</th><th>\u8F93\u5165 / \u8F93\u51FA tokens</th><th>\u6D88\u8017\u79EF\u5206</th></tr></thead><tbody>${usage.map((item) => `<tr><td>${esc(date(item.occurred_at))}</td><td>${esc(getBoxName(item.device_id) || item.device_id)}</td><td>${esc(item.model)}</td><td>${esc(item.input_tokens)} / ${esc(item.output_tokens)}</td><td>${esc(displayCreditAtoms(item.debit_credit_atoms, "consumption"))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">\u6682\u65E0\u5DF2\u7ED3\u7B97\u6D88\u8D39\u3002</p>'}
      ${nextUsage ? `<button class="text-button" data-action="credits-usage-more" ${usageLoading ? "disabled" : ""}>\u67E5\u770B\u66F4\u591A</button>` : ""}</section>`;
    }
    function registrationView() {
      const grant = remote?.registration_grant;
      if (!grant) return "";
      const labels = {
        queued: "\u6CE8\u518C\u8D60\u9001\u5F85\u5230\u8D26",
        running: "\u6CE8\u518C\u8D60\u9001\u5904\u7406\u4E2D",
        retry_wait: "\u6CE8\u518C\u8D60\u9001\u6B63\u5728\u91CD\u8BD5",
        review_required: "\u6CE8\u518C\u8D60\u9001\u5F85\u6838\u5BF9",
        credited: "\u6CE8\u518C\u8D60\u9001\u5DF2\u5230\u8D26",
        historical_received: "\u5386\u53F2\u6CE8\u518C\u8D60\u9001\u5DF2\u9886\u53D6",
        waiting_migration: "\u6CE8\u518C\u8D60\u9001\u8D44\u683C\u5DF2\u6838\u5B9E\uFF0C\u7B49\u5F85\u5904\u7406"
      };
      return `<p role="status">${esc(labels[grant.state] || grant.state)}${grant.credit_display ? ` \xB7 ${esc(amount(grant.credit_display.grant_credit_atoms))} \u65B0\u79EF\u5206` : ""}</p>`;
    }
    const products = () => catalog?.products?.length ? catalog.products : catalog?.tiers || [];
    const productKey = (product) => product.product_id || String(product.amount_fen);
    const locked = () => writing || confirmingPurchase || Boolean(pendingOrder(order) || intent);
    const customRule = () => {
      const v2 = catalog?.custom_amount;
      if (v2 === true) return { enabled: true, version: "usd-credit-100-v2", min_amount_fen: 1e3, max_amount_fen: 1e5, points_per_yuan: "100" };
      if (v2 && typeof v2 === "object" && Number.isSafeInteger(v2.min_fen) && Number.isSafeInteger(v2.max_fen) && Number.isSafeInteger(v2.step_fen) && v2.min_fen >= 1e3 && v2.max_fen >= v2.min_fen && v2.step_fen > 0) {
        return { enabled: true, version: "usd-credit-100-v2", min_amount_fen: v2.min_fen, max_amount_fen: v2.max_fen, step_fen: v2.step_fen, points_per_yuan: "100" };
      }
      const rule = catalog?.custom_recharge;
      return rule?.enabled && rule.points_per_yuan === "100" && typeof rule.version === "string" && Number.isSafeInteger(rule.min_amount_fen) && rule.min_amount_fen >= 1 && Number.isSafeInteger(rule.max_amount_fen) && rule.max_amount_fen >= rule.min_amount_fen && rule.max_amount_fen <= 1e10 ? rule : null;
    };
    const customFen = () => {
      const rule = customRule(), match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(customAmount.trim());
      if (!rule || !match) return null;
      const fen = Number(BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0")));
      return fen >= rule.min_amount_fen && fen <= rule.max_amount_fen ? fen : null;
    };
    async function quoteCustom(value) {
      const rule = customRule();
      if (!identity || locked() || visibleLoading() || !catalog?.recharge_enabled || !rule || catalog?.currency_rule_id !== "usd-credit-100-v2") return;
      customText = String(value);
      customAmount = customText;
      customQuote = null;
      selectedAmount = "custom";
      error = "";
      const amountFen = Number(customText) * 100;
      if (!/^[1-9][0-9]{1,3}$/.test(customText) || amountFen < rule.min_amount_fen || amountFen > rule.max_amount_fen || amountFen % rule.step_fen !== 0) {
        error = message({ code: "VALIDATION_ERROR" });
        notify();
        return;
      }
      const g = generation, requested = amountFen;
      writing = true;
      notify();
      try {
        const value2 = await read("quote", { amount_fen: requested });
        if (g !== generation || value2.view_version !== "2" || value2.currency_rule_id !== "usd-credit-100-v2" || typeof value2.rule_id !== "string" || value2.credit_scale !== 6 || value2.amount_fen !== requested || creditAtoms(value2.grant_credit_atoms) <= 0n) throw new Error("CREDITS_INVALID_RESPONSE");
        customQuote = value2;
      } catch (cause) {
        if (g === generation) error = message(cause);
      } finally {
        if (g === generation) {
          writing = false;
          notify();
        }
      }
    }
    const draft = () => {
      if (selectedAmount === "custom") {
        if (customQuote) return { ...customQuote, target: { amount_fen: customQuote.amount_fen, currency_rule_id: "usd-credit-100-v2" } };
        if (catalog?.currency_rule_id === "usd-credit-100-v2") return null;
        const fen = customFen();
        return fen === null ? null : {
          amount_fen: fen,
          grant_credit_atoms: (BigInt(fen) * 1000000n).toString(),
          target: { custom_amount_fen: fen, custom_recharge_version: customRule().version }
        };
      }
      const product = products().find((item) => productKey(item) === selectedAmount && item.enabled !== false);
      return product ? { ...product, target: product.product_id ? { product_id: product.product_id, product_version: product.version, ...catalog.currency_rule_id ? { currency_rule_id: catalog.currency_rule_id } : {} } : { amount_fen: product.amount_fen, ...catalog.currency_rule_id ? { currency_rule_id: catalog.currency_rule_id } : {} } } : null;
    };
    function select(value) {
      if (locked()) return;
      selectedAmount = value;
      order = null;
      cancellationAccepted = cancellationClosed = false;
      error = "";
      dialogOpen = true;
      notify();
    }
    async function purchase(selection = draft(), channel = selectedChannel) {
      if (!identity || !recoveryReady || recovering || checkingOrder || locked() || !catalog?.recharge_enabled || !selection || !channels().includes(channel)) return;
      const g = generation;
      writing = true;
      error = "";
      dialogOpen = true;
      order = null;
      cancellationAccepted = false;
      notify();
      const confirmStarted = monotonic();
      let outcome = "failed";
      try {
        if (!intent) save({
          purchase_intent_id: uuid(),
          ...selection.target,
          ...catalog.payment_channels ? { payment_channel: channel } : {}
        });
        await recover(g);
        outcome = "completed";
      } catch (cause) {
        if (g !== generation) return;
        error = message(cause);
        if (!order && ["REVISION_CONFLICT", "CONTRACT_NOT_CONFIGURED", "VALIDATION_ERROR", "UNSUPPORTED_SCHEMA"].includes(cause?.code || cause?.message)) {
          discardRejectedIntent(cause);
          try {
            const value = await read("catalog");
            if (g === generation) catalog = value;
          } catch {
          }
        }
        const original = cause?.details?.blocking_order_ids?.[0];
        if (original) {
          try {
            await acceptOrder(await read("order", { order_id: original }), g);
          } catch (failure) {
            if (g === generation) error = message(failure);
          }
        }
      } finally {
        if (g === generation) {
          timing("confirm", confirmStarted, { outcome, qrReady: Boolean(paymentImage()) });
          writing = false;
          notify();
          poll();
        }
      }
    }
    async function close() {
      if (!order || writing || recovering || checkingOrder || order.payment_state === "paid") return;
      const g = generation;
      writing = true;
      error = "";
      qrImage = null;
      notify();
      const closeStarted = monotonic();
      let outcome = "failed";
      try {
        const value = {
          ...intent || { purchase_intent_id: order.purchase_intent_id, amount_fen: order.amount_fen },
          order_id: order.order_id,
          close_intent_id: intent?.close_intent_id || uuid()
        };
        save(value);
        await recover(g);
        outcome = "completed";
      } catch (cause) {
        if (g === generation) error = message(cause);
      } finally {
        if (g === generation) {
          timing("close", closeStarted, { outcome });
          writing = false;
          notify();
          poll();
        }
      }
    }
    const paymentImage = () => qrImage && order && !intent?.close_intent_id && order.payment_state === "pending" && now() < Date.parse(order.expires_at) && now() < Date.parse(order.payment_action?.expires_at) ? qrImage : null;
    const checkoutStep = () => {
      if (order?.review_state === "open" || order?.display_state === "credited" && orderGrantCreditAtoms(order) === null) return "payment";
      return cancellationAccepted || ["credited", "closed"].includes(order?.display_state) ? "result" : order || intent || confirmingPurchase ? "payment" : "selection";
    };
    function paymentView() {
      const state = order?.display_state;
      const expired = order && (now() >= Date.parse(order.expires_at) || order.payment_action && now() >= Date.parse(order.payment_action.expires_at));
      const selection = draft();
      const grant = order ? orderGrantCreditAtoms(order) : selection?.grant_credit_atoms;
      const grantText = grant == null ? "" : amount(grant);
      let title = selection ? "\u786E\u8BA4\u8D2D\u4E70" : "\u9009\u62E9\u5145\u503C\u91D1\u989D", description = selection ? `\u5E94\u4ED8 \xA5${selection.amount_fen / 100} \xB7 \u5230\u8D26 ${amount(selection.grant_credit_atoms)} \u70B9\u79EF\u5206` : "\u9009\u62E9\u5546\u54C1\u6216\u8F93\u5165\u81EA\u5B9A\u4E49\u91D1\u989D\uFF0C\u9009\u62E9\u652F\u4ED8\u65B9\u5F0F\u540E\u786E\u8BA4\u8D2D\u4E70\u3002", success = false;
      if (cancellationAccepted) {
        title = cancellationClosed ? "\u8BA2\u5355\u5DF2\u53D6\u6D88" : "\u53D6\u6D88\u8BF7\u6C42\u5DF2\u53D7\u7406";
        description = cancellationClosed ? "\u60A8\u5DF2\u53D6\u6D88\u672C\u6B21\u652F\u4ED8\uFF0C\u53EF\u91CD\u65B0\u9009\u62E9\u5145\u503C\u5546\u54C1\u3002" : "\u8BF7\u52FF\u7EE7\u7EED\u652F\u4ED8\u539F\u4ED8\u6B3E\u7801\uFF1B\u5982\u5DF2\u4ED8\u6B3E\uFF0C\u6211\u4EEC\u4F1A\u7EE7\u7EED\u786E\u8BA4\u5230\u8D26\u3002";
      } else if (order?.review_state === "open") {
        title = "\u652F\u4ED8\u7ED3\u679C\u5F85\u6838\u5BF9";
        description = `${order.payment_state === "paid" ? "\u5DF2\u652F\u4ED8\u3002" : "\u4ED8\u6B3E\u7ED3\u679C\u5C1A\u5F85\u6838\u5B9E\u3002"}${order.fulfillment_state === "credited" ? "\u79EF\u5206\u5DF2\u5230\u8D26\u3002" : "\u79EF\u5206\u5230\u8D26\u60C5\u51B5\u6B63\u5728\u6838\u5BF9\u3002"}\u8BF7\u52FF\u91CD\u590D\u652F\u4ED8\u3002`;
      } else if (state === "credited") {
        title = "\u79EF\u5206\u5DF2\u5230\u8D26";
        description = grant === null ? "\u5230\u8D26\u79EF\u5206\u5F85\u6838\u5BF9\uFF0C\u8BF7\u7A0D\u540E\u5237\u65B0\u3002" : `${grantText} \u70B9\u79EF\u5206\u5DF2\u8BB0\u5165\u5F53\u524D\u8D26\u53F7\u3002`;
        success = grant !== null;
      } else if (order?.payment_state === "paid") {
        title = "\u652F\u4ED8\u6210\u529F\uFF0C\u79EF\u5206\u5230\u8D26\u4E2D";
        description = "\u6B63\u5728\u66F4\u65B0\u79EF\u5206\u4F59\u989D\uFF0C\u8BF7\u52FF\u91CD\u590D\u652F\u4ED8\u3002\u5173\u95ED\u5F39\u6846\u540E\u4ECD\u4F1A\u7EE7\u7EED\u786E\u8BA4\u5230\u8D26\u3002";
      } else if (state === "closed") {
        title = "\u8BA2\u5355\u5DF2\u53D6\u6D88";
        description = "\u53EF\u4EE5\u91CD\u65B0\u9009\u62E9\u79EF\u5206\u5546\u54C1\uFF0C\u751F\u6210\u65B0\u7684\u4ED8\u6B3E\u7801\u3002";
      } else if (intent?.close_intent_id || order?.payment_state === "close_pending") {
        title = "\u5173\u95ED\u786E\u8BA4\u4E2D";
        description = "\u6B63\u5728\u786E\u8BA4\u539F\u4ED8\u6B3E\u7801\u5DF2\u5931\u6548\uFF0C\u786E\u8BA4\u540E\u5373\u53EF\u91CD\u65B0\u9009\u62E9\u3002\u8BF7\u52FF\u7EE7\u7EED\u652F\u4ED8\u539F\u4ED8\u6B3E\u7801\u3002";
      } else if (expired) {
        title = "\u4ED8\u6B3E\u7801\u5DF2\u5230\u671F";
        description = "\u6B63\u5728\u786E\u8BA4\u652F\u4ED8\u6216\u5173\u95ED\u7ED3\u679C\uFF0C\u786E\u8BA4\u524D\u8BF7\u52FF\u91CD\u590D\u8D2D\u4E70\u3002";
      } else if (order && grant === null) {
        title = "\u5230\u8D26\u79EF\u5206\u5F85\u6838\u5BF9";
        description = "\u672C\u6B21\u8D2D\u4E70\u7684\u79EF\u5206\u6570\u989D\u6B63\u5728\u6838\u5BF9\uFF0C\u8BF7\u7A0D\u540E\u5237\u65B0\u6216\u53D6\u6D88\u672C\u6B21\u8D2D\u4E70\u3002";
      } else if (paymentImage()) {
        const wechat = order.payment_action.payload.startsWith("weixin://");
        title = wechat ? "\u5FAE\u4FE1\u626B\u7801\u652F\u4ED8" : "\u652F\u4ED8\u5B9D\u626B\u7801\u652F\u4ED8";
        description = `\u5E94\u4ED8 \xA5${order.amount_fen / 100} \xB7 \u5230\u8D26 ${grantText} \u70B9\u79EF\u5206`;
      } else if (confirmingPurchase) {
        title = "\u6B63\u5728\u786E\u8BA4\u8D2D\u4E70";
        description = "\u6B63\u5728\u786E\u8BA4\u5F53\u524D\u8BA2\u5355\u72B6\u6001\uFF0C\u8BF7\u7A0D\u5019\u3002";
      } else if (order?.payment_state === "creating" || writing) {
        title = "\u6B63\u5728\u751F\u6210\u4ED8\u6B3E\u7801";
        description = "\u8BF7\u7A0D\u5019\uFF0C\u4ED8\u6B3E\u7801\u751F\u6210\u540E\u4F1A\u663E\u793A\u5728\u4E0B\u65B9\u3002";
      } else if (intent && !order) {
        title = "\u8D2D\u4E70\u7ED3\u679C\u786E\u8BA4\u4E2D";
        description = "\u5DF2\u4FDD\u7559\u672C\u6B21\u8D2D\u4E70\uFF0C\u6B63\u5728\u6062\u590D\u4ED8\u6B3E\u7ED3\u679C\uFF0C\u8BF7\u52FF\u91CD\u590D\u8D2D\u4E70\u3002";
      } else if (order?.payment_state === "pending") {
        title = "\u6B63\u5728\u83B7\u53D6\u4ED8\u6B3E\u7801";
        description = "\u6B63\u5728\u6062\u590D\u672C\u6B21\u8D2D\u4E70\uFF0C\u8BF7\u7A0D\u5019\u6216\u5237\u65B0\u652F\u4ED8\u72B6\u6001\u3002";
      } else if (!catalog?.recharge_enabled || !products().length && !customRule()) {
        title = visibleLoading() ? "\u6B63\u5728\u8BFB\u53D6\u5546\u54C1" : "\u8D2D\u4E70\u6682\u4E0D\u53EF\u7528";
        description = visibleLoading() ? "\u8BF7\u7A0D\u5019\u3002" : "\u79EF\u5206\u8D2D\u4E70\u6682\u672A\u5F00\u653E\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002";
      }
      const step = checkoutStep(), payable = paymentImage();
      const deadline = payable ? Math.min(Date.parse(order.expires_at), Date.parse(order.payment_action.expires_at)) : null;
      const seconds = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now()) / 1e3));
      const countdown = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      const cancelled = cancellationAccepted || state === "closed";
      return `<section class="wallet-payment ${success ? "is-success" : ""} ${step === "selection" ? "is-selection" : ""}" aria-label="\u652F\u4ED8\u8FDB\u5EA6">
      ${step === "selection" && catalog?.recharge_enabled && (products().length || customRule()) ? "" : `<div class="wallet-payment-status" role="status" aria-live="polite">${!payable && step !== "selection" ? `<div class="wallet-payment-mark" aria-hidden="true">${success ? "\u2713" : cancelled ? "\xD7" : "\u2026"}</div>` : ""}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`}
      ${payable ? `<div class="wallet-qr-frame" data-channel="${selectedChannel}"><img class="wallet-qr" alt="\u79EF\u5206\u652F\u4ED8\u4E8C\u7EF4\u7801" src="${esc(qrImage)}"></div>
        <p class="wallet-scan-hint">\u8BF7\u4F7F\u7528\u624B\u673A${selectedChannel === "wechat" ? "\u5FAE\u4FE1" : "\u652F\u4ED8\u5B9D"}\u626B\u7801\u5B8C\u6210\u652F\u4ED8</p>
        <div class="wallet-payment-clock"><span>\u5269\u4F59\u652F\u4ED8\u65F6\u95F4</span><strong data-wallet-deadline="${deadline}" role="timer" aria-live="off">${countdown}</strong><span>\u7B49\u5F85\u652F\u4ED8\uFF0C\u4ED8\u6B3E\u540E\u81EA\u52A8\u66F4\u65B0</span></div>` : ""}
      ${error ? `<p class="notice" role="alert">${esc(error)}</p>` : ""}
      ${step === "selection" ? `<div class="wallet-checkout-total"><span>\u5E94\u4ED8\u91D1\u989D<strong>${selection ? `\xA5${selection.amount_fen / 100}` : "\u2014"}</strong></span><span>${selection ? `\u5230\u8D26 ${esc(amount(selection.grant_credit_atoms))} \u79EF\u5206` : "\u8BF7\u9009\u62E9\u5546\u54C1\u6216\u83B7\u53D6\u81EA\u5B9A\u4E49\u62A5\u4EF7"}</span></div>` : ""}
      <div class="wallet-payment-actions">
        ${step === "selection" ? `<button class="button primary wallet-pay" data-action="credits-pay" ${!selection || locked() || !catalog?.recharge_enabled || !recoveryReady || visibleRecovery() || checkingOrder || !channels().includes(selectedChannel) ? "disabled" : ""}>\u786E\u8BA4\u8D2D\u4E70</button>` : ""}
        ${step === "payment" && (order || intent || error) || error ? `<button class="text-button" data-action="credits-refresh" ${visibleLoading() || writing || checkingOrder ? "disabled" : ""}>${visibleLoading() ? "\u6B63\u5728\u786E\u8BA4\u2026" : "\u5237\u65B0\u652F\u4ED8\u72B6\u6001"}</button>` : ""}
        ${step === "payment" && order && ["creating", "pending"].includes(order.payment_state) && !intent?.close_intent_id ? `<button class="button wallet-cancel" data-action="credits-close-order" ${visibleRecovery() || checkingOrder || writing ? "disabled" : ""}>\u53D6\u6D88\u8BA2\u5355</button>` : ""}
        ${step === "result" ? `<button class="button primary" data-action="credits-result-confirm">${success ? "\u5B8C\u6210" : "\u786E\u8BA4"}</button>` : ""}
      </div>
      ${pendingOrder(order) || intent ? '<p class="wallet-payment-footnote">\u5173\u95ED\u7A97\u53E3\u540E\u4ECD\u53EF\u7EE7\u7EED\u67E5\u770B\u652F\u4ED8\u7ED3\u679C</p>' : ""}
    </section>`;
    }
    function dialog() {
      if (!dialogOpen) return "";
      const step = checkoutStep();
      const selected = pendingOrder(order) ? intent?.custom_recharge_version || intent?.currency_rule_id && !intent?.product_id ? "custom" : intent?.product_id || String(order.amount_fen) : selectedAmount;
      const rule = customRule();
      const invalidAmount = selectedAmount === "custom" && customAmount !== "" && customFen() === null;
      return `<div class="wallet-modal"><section class="wallet-purchase-dialog" data-step="${step}" role="dialog" aria-modal="true" aria-labelledby="wallet-purchase-title" tabindex="-1">
      <header class="wallet-purchase-heading"><div><h2 id="wallet-purchase-title">${step === "selection" ? "\u8D2D\u4E70\u79EF\u5206" : step === "payment" ? "\u8BA2\u5355\u652F\u4ED8" : "\u8BA2\u5355\u7ED3\u679C"}</h2><p>${step === "selection" ? "\u9009\u62E9\u5145\u503C\u91D1\u989D\u4E0E\u652F\u4ED8\u65B9\u5F0F\uFF0C\u5145\u503C\u79EF\u5206\u957F\u671F\u6709\u6548" : step === "payment" ? "\u8BF7\u6838\u5BF9\u91D1\u989D\u540E\u626B\u7801\u652F\u4ED8" : "\u672C\u6B21\u8D2D\u4E70\u7684\u5904\u7406\u7ED3\u679C"}</p></div><button class="wallet-dialog-close" data-action="credits-dismiss" aria-label="\u5173\u95ED\u8D2D\u4E70\u5F39\u6846">\xD7</button></header>
      ${step === "selection" ? `
      <div class="wallet-products" aria-label="\u79EF\u5206\u5546\u54C1">${products().map((tier) => `<button class="wallet-product" data-action="credits-buy" data-amount="${esc(productKey(tier))}" aria-pressed="${selected === productKey(tier)}" ${!catalog?.recharge_enabled || tier.enabled === false || locked() ? "disabled" : ""}>
        ${tier.name ? `<span>${esc(tier.name)}</span>` : ""}<span class="wallet-product-points">${esc(amount(tier.grant_credit_atoms))}<small>\u70B9\u79EF\u5206</small></span><strong>\xA5${tier.amount_fen / 100}</strong><span class="wallet-product-selection">${selected === productKey(tier) ? "\u5DF2\u9009\u62E9" : "\u9009\u62E9\u5546\u54C1"}</span></button>`).join("")}</div>
      ${catalog?.custom_amount ? `<div class="wallet-custom" data-selected="${selected === "custom"}">
        <label for="wallet-custom-amount">\u81EA\u5B9A\u4E49\u91D1\u989D\uFF0810\uFF5E1000 \u6574\u6570\u5143\uFF09</label>
        <input id="wallet-custom-amount" data-wallet-input="custom-amount" inputmode="numeric" autocomplete="off" maxlength="4" value="${esc(customText)}" ${locked() ? "disabled" : ""}>
        <button class="button" data-action="credits-quote" ${!catalog.recharge_enabled || locked() ? "disabled" : ""}>\u83B7\u53D6\u62A5\u4EF7</button>
        ${customQuote ? `<p>\u652F\u4ED8 \xA5${customQuote.amount_fen / 100} \xB7 \u5230\u8D26 ${esc(amount(customQuote.grant_credit_atoms))} \u79EF\u5206</p><button class="button" data-action="credits-custom-buy" aria-pressed="${selected === "custom"}" ${locked() ? "disabled" : ""}>${selected === "custom" ? "\u5DF2\u9009\u62E9\u81EA\u5B9A\u4E49\u91D1\u989D" : "\u9009\u62E9\u6B64\u91D1\u989D"}</button>` : ""}
      </div>` : `<div class="wallet-custom" data-selected="${selected === "custom"}">
        <button class="text-button" data-action="credits-custom" aria-pressed="${selected === "custom"}" ${!catalog?.recharge_enabled || !rule || locked() ? "disabled" : ""}>\u81EA\u5B9A\u4E49\u91D1\u989D</button>
        <label for="wallet-custom-amount">\xA5 <input id="wallet-custom-amount" type="text" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="\u8F93\u5165\u91D1\u989D\uFF08\u5143\uFF09" aria-label="\u81EA\u5B9A\u4E49\u5145\u503C\u91D1\u989D\uFF08\u5143\uFF09" aria-describedby="wallet-custom-hint" aria-invalid="${invalidAmount}" value="${esc(customAmount)}" ${!catalog?.recharge_enabled || !rule || locked() ? "disabled" : ""}></label>
        <p id="wallet-custom-hint" ${invalidAmount ? 'role="status"' : ""}>${!rule ? "\u81EA\u5B9A\u4E49\u5145\u503C\u6682\u4E0D\u53EF\u7528" : invalidAmount ? `\u8BF7\u8F93\u5165 \xA5${rule.min_amount_fen / 100} \u81F3 \xA5${rule.max_amount_fen / 100} \u7684\u91D1\u989D\uFF0C\u6700\u591A\u4E24\u4F4D\u5C0F\u6570\u3002` : `1 \u5143\u5151\u6362 100 \u79EF\u5206${selectedAmount === "custom" && customFen() !== null ? ` \xB7 \u53EF\u5F97 ${amount((BigInt(customFen()) * 1000000n).toString())} \u70B9\u79EF\u5206` : ""}`}</p>
      </div>`}
      <div class="wallet-channel-section"><h3>\u652F\u4ED8\u65B9\u5F0F</h3>      <div class="wallet-payment-actions wallet-channel-picker" aria-label="\u652F\u4ED8\u65B9\u5F0F">${channels().map((channel) => `<button class="button ${selectedChannel === channel ? "primary" : ""}" data-action="credits-channel" data-channel="${channel}" aria-pressed="${selectedChannel === channel}" ${locked() ? "disabled" : ""}>${channel === "wechat" ? "\u5FAE\u4FE1\u652F\u4ED8" : "\u652F\u4ED8\u5B9D"}</button>`).join("")}</div></div>` : ""}
      ${paymentView()}
    </section></div>`;
    }
    return {
      reset(value) {
        if (identity === value) return false;
        if (timer !== null) cancel(timer);
        if (qrTimer !== null) cancel(qrTimer);
        qrTimer = null;
        identity = value;
        generation++;
        account = value ? JSON.parse(value)[0] : null;
        catalog = balance = order = qrImage = selectedAmount = remote = null;
        usage = [];
        nextUsage = null;
        usageLoading = false;
        dialogOpen = loading = writing = recoveryReady = recovering = checkingOrder = orderReadFailed = false;
        error = "";
        timer = null;
        customAmount = "";
        customText = "";
        customQuote = null;
        backgroundLoading = confirmingPurchase = cancellationAccepted = cancellationClosed = false;
        recoveryTask = null;
        selectedChannel = "alipay";
        intent = account ? load() : null;
        if (intent?.payment_channel) selectedChannel = intent.payment_channel;
        if (intent?.custom_recharge_version) {
          selectedAmount = "custom";
          customAmount = String(intent.custom_amount_fen / 100);
        }
        if (intent?.currency_rule_id && !intent?.product_id) {
          selectedAmount = "custom";
          customText = String(intent.amount_fen / 100);
        }
        return true;
      },
      refresh,
      paymentImage,
      isOpen: () => dialogOpen,
      label: () => displayedBalance() != null ? `${amount(displayedBalance())} \u70B9` : visibleLoading() ? "\u8BFB\u53D6\u4E2D\u2026" : "\u6682\u4E0D\u53EF\u7528",
      async action(action, dataset = {}) {
        if (action === "credits-open") {
          dialogOpen = true;
          notify();
          return;
        }
        if (action === "credits-dismiss") {
          dialogOpen = false;
          if (checkoutStep() === "result" && !pendingOrder(order)) {
            order = null;
            cancellationAccepted = cancellationClosed = false;
          }
          notify();
          return;
        }
        if (action === "credits-result-confirm" && checkoutStep() === "result" && !pendingOrder(order)) {
          order = null;
          cancellationAccepted = cancellationClosed = false;
          error = "";
          notify();
          return;
        }
        if (action === "credits-refresh") return refresh();
        if (action === "credits-usage-more") return loadUsage();
        if (action === "credits-channel") {
          if (!locked() && channels().includes(dataset.channel)) {
            selectedChannel = dataset.channel;
            notify();
          }
          return;
        }
        if (action === "credits-buy" && products().some((item) => productKey(item) === String(dataset.amount) && item.enabled !== false)) return select(String(dataset.amount));
        if (action === "credits-custom" && customRule()) return select("custom");
        if (action === "credits-custom-change") {
          if (!locked()) {
            customText = String(dataset.amount ?? dataset.value);
            customAmount = customText;
            customQuote = null;
            notify();
          }
          return;
        }
        if (action === "credits-quote") return quoteCustom(dataset.amount ?? customText);
        if (action === "credits-custom-buy" && customQuote) return select("custom");
        if (action === "credits-amount" && customRule() && !locked()) {
          customAmount = String(dataset.value).slice(0, 12);
          return select("custom");
        }
        if (action === "credits-confirm") action = "credits-pay";
        if (action === "credits-pay" || action === "credits-close-order") {
          const g = generation;
          if (action === "credits-pay" && backgroundLoading && recoveryTask) {
            const selection = draft(), channel = selectedChannel;
            if (!selection || writing || pendingOrder(order) || intent) return;
            confirmingPurchase = true;
            notify();
            try {
              await recoveryTask;
              if (g !== generation) return;
              confirmingPurchase = false;
              return await purchase(selection, channel);
            } finally {
              if (g === generation) {
                confirmingPurchase = false;
                notify();
              }
            }
          }
          if (backgroundLoading && recoveryTask) await recoveryTask;
          if (g !== generation) return;
          return action === "credits-pay" ? purchase() : close();
        }
      },
      render() {
        return `<div class="page-content credits-page" ${dialogOpen ? "inert" : ""}>
        <div class="page-heading"><div><h2>\u8D26\u53F7\u79EF\u5206</h2><p class="muted">\u67E5\u770B\u8D26\u53F7\u4F59\u989D\uFF0C\u8D2D\u4E70\u7684\u79EF\u5206\u957F\u671F\u6709\u6548\u3002</p></div></div>
        ${error && !dialogOpen ? `<div class="notice" role="status">${esc(error)}${balance ? " \u5F53\u524D\u663E\u793A\u4E0A\u6B21\u8BFB\u53D6\u7684\u4F59\u989D\u3002" : ""}</div>` : ""}
        <section class="credits-overview"><div><p class="eyebrow">\u79EF\u5206\u4F59\u989D</p><div class="credits-total">${displayedBalance() != null ? esc(amount(displayedBalance())) : "\u2014"}<span>\u70B9</span></div>
        <p class="muted">\u79EF\u5206\u5F52\u5F53\u524D\u4E07\u8C61\u8D26\u53F7\u6240\u6709\uFF0C\u8DE8\u8BBE\u5907\u5171\u4EAB\u3002</p></div>
        <div class="credits-recharge"><button class="button primary" data-action="credits-open">\u8D2D\u4E70\u79EF\u5206</button>${pendingOrder(order) || intent ? "<p>\u6709\u4E00\u7B14\u8D2D\u4E70\u6B63\u5728\u5904\u7406\u4E2D\uFF0C\u70B9\u51FB\u7EE7\u7EED\u67E5\u770B\u3002</p>" : ""}</div></section>
        ${remoteView()}
        <p class="credits-hint">\u4ED8\u6B3E\u540E\u8BF7\u7B49\u5F85\u79EF\u5206\u5230\u8D26\uFF0C\u53EF\u5728\u8D2D\u4E70\u5F39\u6846\u4E2D\u67E5\u770B\u5904\u7406\u72B6\u6001\u3002</p>
      </div>${dialog()}`;
      }
    };
  }

  // local-ui/renderer/wallet-entry.mjs
  window.createWalletView = (options) => createWalletView({
    ...options,
    qr: (payload) => import_qrcode.default.toDataURL(payload, { width: 240, margin: 3, errorCorrectionLevel: "M" })
  });
})();
