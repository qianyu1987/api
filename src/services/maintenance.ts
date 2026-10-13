import type { Database } from '../db/index.js'

export const MEDIA_RETENTION_DAYS = 90
export async function maintainStorage(db: Database): Promise<void> {
  // Never remove source uploads while a task may still need them. Published
  // works stay available; private expired results keep their task and bill.
  await db.query(`DELETE FROM media_uploads u WHERE u.expires_at<now() AND NOT EXISTS(
    SELECT 1 FROM media_tasks t WHERE t.status NOT IN ('completed','failed') AND t.request_payload::text LIKE '%'||u.token||'%')`)
  await db.query(`DELETE FROM media_task_assets a USING media_tasks t WHERE t.id=a.task_id
    AND t.status='completed' AND t.gallery_status<>'published' AND t.finished_at<now()-interval '90 days'
    AND EXISTS(SELECT 1 FROM operations_snapshots WHERE id='host' AND checked_at>now()-interval '24 hours' AND metrics->>'backupVerified'='true')`)
  await db.query(`DELETE FROM channel_health_observations WHERE created_at<now()-interval '7 days'`)
  await db.query(`DELETE FROM media_task_events WHERE created_at<now()-interval '90 days'`)
  await db.query(`DELETE FROM product_events WHERE event IN ('visit','recharge_opened') AND created_at<now()-interval '180 days'`)
}

export async function refreshOperationsAlerts(db: Database): Promise<void> {
  const [host, tables, payments] = await Promise.all([
    db.one<any>(`SELECT metrics,checked_at FROM operations_snapshots WHERE id='host'`),
    db.query<any>(`SELECT relname,pg_total_relation_size(relid)::text AS bytes FROM pg_stat_user_tables WHERE pg_total_relation_size(relid)>1073741824`),
    db.one<any>(`SELECT count(*)::int AS missing FROM orders o WHERE o.status='paid' AND o.paid_at<now()-interval '1 minute'
      AND CASE WHEN o.kind='wallet_topup' THEN NOT EXISTS(SELECT 1 FROM wallet_ledger w WHERE w.order_id=o.id AND w.kind='wallet_topup')
      ELSE NOT EXISTS(SELECT 1 FROM subscription_purchases s WHERE s.order_id=o.id) END`),
  ])
  const issues: Array<{ id: string; message: string; severity: string }> = []
  const metrics = host?.metrics || {}
  if (!host || Date.now()-new Date(host.checked_at).getTime()>86400_000) issues.push({id:'host-metrics-stale',message:'主机存储监测尚未更新，请检查运维定时任务',severity:'warning'})
  if (host && metrics.backupVerified !== true) issues.push({id:'backup-verification',message:metrics.backupError?'最新数据库备份恢复校验失败，已禁止清理':'近期数据库备份尚未通过完整恢复校验，清理保持暂停',severity:metrics.backupError?'critical':'warning'})
  if (Number(metrics.diskUsedPercent)>=80) issues.push({id:'disk',message:`主机磁盘已用 ${Number(metrics.diskUsedPercent).toFixed(1)}%，告警线80%，严重线90%`,severity:Number(metrics.diskUsedPercent)>=90?'critical':'warning'})
  if (Number(metrics.backupBytes)>=20*1024**3) issues.push({id:'backups',message:'本站数据库备份超过20GB，请执行已校验的保留策略',severity:'warning'})
  if (Number(metrics.projectImages)>=30) issues.push({id:'images',message:'本站Docker镜像超过30个，请保留回滚镜像后清理过期版本',severity:'warning'})
  if (Number(metrics.buildCacheBytes)>=8*1024**3) issues.push({id:'build-cache',message:'主机共享Docker构建缓存超过8GB，请检查项目独立缓存；不会全局清理其他项目缓存',severity:Number(metrics.buildCacheBytes)>=16*1024**3?'critical':'warning'})
  for (const t of tables) issues.push({id:'table:'+t.relname,message:`数据库表 ${t.relname} 超过1GB，请检查媒体保留与增长`,severity:'warning'})
  if (Number(payments?.missing)>0) issues.push({id:'uncredited',message:`发现 ${payments.missing} 笔已付订单超过1分钟未到账，需核对支付流水`,severity:'critical'})
  await db.tx(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('operations-alerts'))`)
    for (const issue of issues) {
      await client.query(`INSERT INTO risk_alerts(kind,severity,resource_type,resource_id,message)
        SELECT 'operations',$2,'operations',$1,$3 WHERE NOT EXISTS(SELECT 1 FROM risk_alerts WHERE kind='operations' AND resource_id=$1 AND status<>'resolved')`, [issue.id,issue.severity,issue.message])
      await client.query(`UPDATE risk_alerts SET message=$3,severity=$2 WHERE kind='operations' AND resource_id=$1 AND status<>'resolved'`,[issue.id,issue.severity,issue.message])
    }
    await client.query(`UPDATE risk_alerts SET status='resolved',resolved_at=now() WHERE kind='operations' AND status<>'resolved' AND NOT(resource_id=ANY($1::text[]))`,[issues.map(i=>i.id)])
  })
}
