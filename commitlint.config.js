module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Le sujet du commit peut être écrit en français ou en anglais : on ne
    // force pas la casse (beaucoup de mots français commencent par une
    // majuscule légitime : noms propres, sigles PM2/SQLite/HTTP...).
    "subject-case": [0],
  },
};
