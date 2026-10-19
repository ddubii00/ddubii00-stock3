'use strict';
module.exports = async function handler(req, res) {
  if (!require('../access-control').requireAccess(req,res)) return;
  res.setHeader('Cache-Control','no-store');
  return res.status(200).json({ok:true});
};
